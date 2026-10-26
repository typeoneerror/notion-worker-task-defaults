import { Worker, WebhookVerificationError } from '@notionhq/workers';
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
  execute: async (events) => {
    for (const event of events) {
      verifyWebhookSecret(event.headers, process.env.LOAD_DEFAULT_TASKS_WEBHOOK_SECRET);
      console.log('Verified loadDefaultTasks request', event.deliveryId);
    }
  },
});

worker.tool('sayHello', {
  title: 'Say Hello',
  description: 'Returns a friendly greeting for the given name.',
  schema: j.object({
    name: j.string().describe('The name to greet.'),
  }),
  execute: ({ name }) => `Hello, ${name}!`,
});
