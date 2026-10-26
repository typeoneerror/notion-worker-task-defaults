import { Worker, WebhookVerificationError, type CapabilityContext } from '@notionhq/workers';
import { j } from '@notionhq/workers/schema-builder';

const worker = new Worker();
export default worker;

function verifyWebhookSecret(headers: Record<string, string>, secret: string | undefined): void {
  if (!secret || headers['x-load-default-tasks-secret'] !== secret) {
    throw new WebhookVerificationError('Invalid webhook secret');
  }
}

worker.webhook('loadDefaultTasks', {
  title: 'Load Default Tasks',
  description: 'Receives requests to load default tasks for projects',
  execute: async (events, { notion }) => {
    for (const event of events) {
      // Make sure it's being called from Notion
      verifyWebhookSecret(event.headers, process.env.LOAD_DEFAULT_TASKS_WEBHOOK_SECRET);

      // Parse the payload from Notion
      const { projectId, template } = parseLoadDefaultTasksPayload(event.body);

      // Start creating the default tasks based on a template name
      await createDefaultTasks(notion, projectId, template);
    }
  },
});

function parseLoadDefaultTasksPayload(body: Record<string, unknown>): {
  projectId: string;
  template: string | null;
} {
  const data = body.data;
  const payload =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;

  const projectId = payload?.id;
  const template = payload?.template ?? null;

  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new Error('Webhook body must include a project identifier as "id"');
  }

  if (template !== null && typeof template !== 'string') {
    throw new Error('Webhook body template must be a string or null');
  }

  return { projectId, template };
}

async function createTask(
  notion: CapabilityContext['notion'],
  name: string,
  projectId: string
): Promise<string> {
  const dataSourceId = process.env.TASKS_DATA_SOURCE_ID;
  if (!dataSourceId) {
    throw new Error('TASKS_DATA_SOURCE_ID is not configured');
  }

  const nameProperty = process.env.TASKS_NAME_PROPERTY || 'Name';
  const templateId: string = process.env.TASKS_TEMPLATE_ID || 'none';

  // template[type]=none (default behavior) doesn't use a template
  // template[type]=default uses the default template
  // template[type]=template_id; template[template_id]=... uses the provided template id
  const template =
    templateId === 'none'
      ? { type: 'none' as const }
      : templateId === 'default'
        ? { type: 'default' as const }
        : { type: 'template_id' as const, template_id: templateId };

  const task = await notion.pages.create({
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      [nameProperty]: { title: [{ text: { content: name } }] },
      Project: { relation: [{ id: projectId }] },
    },
    template,
  });

  return task.id;
}

async function createDefaultTasks(
  notion: CapabilityContext['notion'],
  projectId: string,
  template: string | null = null
) {
  console.log(`createDefaultTasks for project ${projectId} with template ${template}`);

  await createTask(notion, 'Task Default', projectId);
}

worker.tool('createDefaultTasks', {
  title: 'Create Default Tasks',
  description: 'Loads the default tasks for a project given a project and a template name.',
  schema: j.object({
    projectId: j.uuid().describe('The ID of the project to add default tasks to'),
    template: j.string().describe('Name of the template to apply').nullable(),
  }),
  execute: async ({ projectId, template }, { notion }) => {
    await createDefaultTasks(notion, projectId, template);

    return `Started created default tasks for projectId ${projectId} with template ${template}`;
  },
});
