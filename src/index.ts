import { Worker, type CapabilityContext } from '@notionhq/workers';
import { j } from '@notionhq/workers/schema-builder';
import { isFullPage, type CreatePageParameters } from '@notionhq/client';
import { getRelationIds, verifyWebhookSecret } from './utils.js';

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
  notion: CapabilityContext['notion'],
  titleProperty: string,
  title: string,
  projectId: string,
  icon: CreatePageParameters['icon'] = null,
  owners: { id: string }[] = []
): Promise<string> {
  const dataSourceId = process.env.TASKS_DATA_SOURCE_ID;
  if (!dataSourceId) {
    throw new Error('TASKS_DATA_SOURCE_ID is not configured');
  }

  const projectProperty = process.env.TASKS_PROPERTY_PROJECT || 'Project';
  const assigneeProperty = process.env.TASKS_PROPERTY_ASSIGNEE || 'Assignee';

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

  const task = await notion.pages.create({
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      [titleProperty]: { title: [{ text: { content: title } }] },
      [projectProperty]: { relation: [{ id: projectId }] },
      [assigneeProperty]: { people: owners.map(({ id }) => ({ id })) },
    },
    template,
    icon,
  });

  return task.id;
}

type CreatedTask = { id: string; title: string };

async function createDefaultTasks(
  notion: CapabilityContext['notion'],
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
    if (templateRelation?.type !== 'relation' || templateRelation.relation.length !== 1) {
      throw new Error(`Project ${projectId} must have one related page in ${templatePropertyName}`);
    }

    // Load the template page
    templateId = templateRelation.relation[0].id;
  }
  const template = await notion.pages.retrieve({ page_id: templateId });
  if (!isFullPage(template)) {
    throw new Error(`Template ${templateId} did not include properties`);
  }

  // Finally load the defaults associated with the template
  const defaultsPropertyName = process.env.TEMPLATE_DEFAULTS_PROPERTY || 'Defaults';
  const defaultsProperty = template.properties[defaultsPropertyName];
  if (defaultsProperty?.type !== 'relation') {
    throw new Error(`Template ${templateId} must have a relation property ${defaultsPropertyName}`);
  }

  // Because you can only load 25 relations at once, we have to load them until there's none left...
  const taskIds = await getRelationIds(notion, templateId, defaultsProperty.id);
  const tasks = await Promise.all(taskIds.map((page_id) => notion.pages.retrieve({ page_id })));

  // Create a task in the project for each default, in order
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

    const ownerProperty = task.properties[process.env.TASKS_PROPERTY_ASSIGNEE || 'Owner'];
    const owners = ownerProperty?.type === 'people' ? ownerProperty.people : [];

    // Uploaded file icons use expiring URLs and can't be copied
    const icon = task.icon?.type === 'file' ? null : task.icon;

    const id = await createTask(notion, titleProperty.id, title, project.id, icon, owners);
    createdTasks.push({ id, title });
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
      })
    ),
  }),
  execute: async ({ projectId, templateId }, { notion }) => {
    const tasks = await createDefaultTasks(notion, projectId, templateId);

    return { tasks };
  },
});
