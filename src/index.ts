import { Worker } from '@notionhq/workers';
import { j } from '@notionhq/workers/schema-builder';
import {
  Client,
  CreatePageResponse,
  isFullPage,
  type CreatePageParameters,
} from '@notionhq/client';
import {
  getCalendarDate,
  getDateRange,
  getRelationIds,
  verifyWebhookSecret,
  type DateRange,
} from './utils.js';

const worker = new Worker();
export default worker;

function parseLoadDefaultTasksPayload(body: Record<string, unknown>): { projectId: string } {
  const data = body.data as Record<string, unknown> | undefined;
  const projectId = data?.id;

  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new Error('Webhook body must include a project identifier as "id"');
  }

  return { projectId };
}

worker.webhook('loadDefaultTasks', {
  title: 'Load Default Tasks',
  description: 'Receives requests to load default tasks for projects',
  execute: async (events, { notion }) => {
    for (const event of events) {
      // Make sure it's being called from Notion
      verifyWebhookSecret(event.headers, process.env.LOAD_DEFAULT_TASKS_WEBHOOK_SECRET);

      // Parse the payload from Notion
      const { projectId } = parseLoadDefaultTasksPayload(event.body);

      // Start creating the default tasks based on a template name
      await createDefaultTasks(notion, projectId);
    }
  },
});

async function createTask(
  notion: Client,
  titleProperty: string,
  title: string,
  projectId: string,
  // FIXME: this could be PageIconRequest if exported
  icon: CreatePageParameters['icon'] = null,
  assignees: { id: string }[] = [],
  date: DateRange | null = null
): Promise<CreatePageResponse> {
  const dataSourceId = process.env.TASKS_DATA_SOURCE_ID;
  if (!dataSourceId) {
    throw new Error('TASKS_DATA_SOURCE_ID is not configured');
  }

  const projectProperty = process.env.TASKS_PROPERTY_PROJECT || 'Project';
  const assigneeProperty = process.env.TASKS_PROPERTY_ASSIGNEE || 'Assignee';
  const dateProperty = process.env.TASKS_PROPERTY_DATE || 'Date';

  // template[type]=none (default behavior) doesn't use a template
  // template[type]=default uses the default template
  // template[type]=template_id; template[template_id]=... uses the provided template id
  const templateId: string = process.env.TASKS_TEMPLATE_ID || 'none';
  const template =
    templateId === 'none'
      ? { type: 'none' as const }
      : templateId === 'default'
        ? { type: 'default' as const }
        : { type: 'template_id' as const, template_id: templateId };

  console.log(`Creating task "${title}" with template ${templateId}`);

  return await notion.pages.create({
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      [titleProperty]: { title: [{ text: { content: title } }] },
      [projectProperty]: { relation: [{ id: projectId }] },
      [assigneeProperty]: { people: assignees.map(({ id }) => ({ id })) },
      ...(date && { [dateProperty]: { date } }),
    },
    template,
    icon,
  });
}

async function findDefaultTemplateId(notion: Client): Promise<string | null> {
  const dataSourceId = process.env.TEMPLATES_DATA_SOURCE_ID;
  if (!dataSourceId) {
    return null;
  }

  const defaultPropertyName = process.env.TEMPLATES_PROPERTY_DEFAULT || 'Default?';

  console.log(`Looking up template checked as ${defaultPropertyName}`);

  // Oldest checked template wins if more than one is marked as default
  const { results } = await notion.dataSources.query({
    data_source_id: dataSourceId,
    filter: { property: defaultPropertyName, checkbox: { equals: true } },
    sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
    page_size: 1,
  });

  return results[0]?.id ?? null;
}

type CreatedTask = { id: string; title: string; date: DateRange };

async function createDefaultTasks(
  notion: Client,
  projectId: string,
  templateId: string | null = null
): Promise<CreatedTask[]> {
  console.log(`createDefaultTasks for project ${projectId} with templateId ${templateId}`);

  // First fetch the project page
  const project = await notion.pages.retrieve({ page_id: projectId });
  if (!isFullPage(project)) {
    throw new Error(`Project ${projectId} did not include properties`);
  }

  // Then we need to fetch the template the project is set to load
  const templatePropertyName = process.env.PROJECTS_PROPERTY_TEMPLATE || 'Template';
  if (!templateId) {
    const templateRelation = project.properties[templatePropertyName];
    const relatedTemplates = templateRelation?.type === 'relation' ? templateRelation.relation : [];
    if (relatedTemplates.length > 1) {
      throw new Error(
        `Project ${projectId} has more than one related page in ${templatePropertyName}`
      );
    }

    // Fall back to the configured default template, then the template marked as default
    templateId =
      relatedTemplates[0]?.id ||
      process.env.TEMPLATES_DEFAULT_ID ||
      (await findDefaultTemplateId(notion));
    if (!templateId) {
      throw new Error(
        `Project ${projectId} has no ${templatePropertyName}, TEMPLATES_DEFAULT_ID is not configured, and no template is marked as default`
      );
    }
  }

  console.log(`Loading template with id ${templateId}`);

  const template = await notion.pages.retrieve({ page_id: templateId });
  if (!isFullPage(template)) {
    throw new Error(`Template ${templateId} did not include properties`);
  }

  // Finally load the defaults associated with the template
  const defaultsPropertyName = process.env.TEMPLATES_PROPERTY_DEFAULTS || 'Defaults';
  const defaultsProperty = template.properties[defaultsPropertyName];
  if (defaultsProperty?.type !== 'relation') {
    throw new Error(`Template ${templateId} must have a relation property ${defaultsPropertyName}`);
  }

  // Because you can only load 25 relations at once, we have to load them until there's none left...
  const taskIds = await getRelationIds(notion, templateId, defaultsProperty.id);
  const tasks = await Promise.all(taskIds.map((page_id) => notion.pages.retrieve({ page_id })));

  console.log(`${tasks.length} defaults found`);

  // Task dates are offset from the project's date, or today if it doesn't have one
  const timeZone = process.env.TIMEZONE || 'UTC';
  const projectDateProperty = project.properties[process.env.PROJECTS_PROPERTY_DATE || 'Date'];
  const baseDate = getCalendarDate(
    timeZone,
    projectDateProperty?.type === 'date' ? projectDateProperty.date?.start : null
  );
  const dateOffsetPropertyName = process.env.DEFAULTS_PROPERTY_DATE_OFFSET || 'Date Offset';
  const dateRangePropertyName = process.env.DEFAULTS_PROPERTY_DATE_RANGE || 'Date Range';

  // Create a task in the project for each default
  const createdTasks: CreatedTask[] = [];
  for (const task of tasks) {
    if (!isFullPage(task)) {
      throw new Error(`Default task ${task.id} did not include properties`);
    }

    const titleProperty = Object.values(task.properties).find((p) => p.type === 'title');
    if (titleProperty?.type !== 'title') {
      throw new Error('Default task database does not seem to have a title property.');
    }
    const title = titleProperty.title.map((t) => t.plain_text).join('');

    const assigneeProperty = task.properties[process.env.TASKS_PROPERTY_ASSIGNEE || 'Assignee'];
    const assignees = assigneeProperty?.type === 'people' ? assigneeProperty.people : [];

    // Uploaded file icons use expiring URLs and can't be copied
    const icon = task.icon?.type === 'file' ? null : task.icon;

    const dateOffsetProperty = task.properties[dateOffsetPropertyName];
    const dateRangeProperty = task.properties[dateRangePropertyName];
    const dateOffset = dateOffsetProperty?.type === 'number' ? (dateOffsetProperty.number ?? 0) : 0;
    const dateRange = dateRangeProperty?.type === 'number' ? (dateRangeProperty.number ?? 1) : 1;
    const date = getDateRange(baseDate, dateOffset, dateRange);

    const page = await createTask(
      notion,
      titleProperty.id,
      title,
      project.id,
      icon,
      assignees,
      date
    );
    createdTasks.push({ id: page.id, title, date });
  }

  // Clear the template from the project now that its defaults have been created
  await notion.pages.update({
    page_id: project.id,
    properties: {
      [templatePropertyName]: { relation: [] },
    },
  });

  return createdTasks;
}

worker.tool('createDefaultTasks', {
  title: 'Create Default Tasks',
  description: 'Loads the default tasks for a project given a project and a template name.',
  schema: j.object({
    projectId: j.uuid().describe('The ID of the project to add default tasks to'),
    templateId: j.uuid().describe('The ID of the task template to apply').nullable(),
  }),
  outputSchema: j.object({
    tasks: j.array(
      j.object({
        id: j.string().describe('The ID of the created task'),
        title: j.string().describe('The title of the created task'),
        date: j
          .object({
            start: j.string().describe('The start date of the task (yyyy-MM-dd)'),
            end: j.string().describe('The end date of the task (yyyy-MM-dd)').nullable(),
          })
          .describe('The date of the created task'),
      })
    ),
  }),
  execute: async ({ projectId, templateId }, { notion }) => {
    const tasks = await createDefaultTasks(notion, projectId, templateId);

    return { tasks };
  },
});
