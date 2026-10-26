import { WebhookVerificationError, type CapabilityContext } from '@notionhq/workers';

const HEADER = 'x-load-default-tasks-secret';

export function verifyWebhookSecret(
  headers: Record<string, string>,
  secret: string | undefined
): void {
  if (!secret || headers[HEADER] !== secret) {
    throw new WebhookVerificationError('Invalid webhook secret');
  }
}

// pages.retrieve truncates relations at 25 items, so page through the property endpoint
export async function getRelationIds(
  notion: CapabilityContext['notion'],
  pageId: string,
  propertyId: string
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;

  do {
    const response = await notion.pages.properties.retrieve({
      page_id: pageId,
      property_id: propertyId,
      start_cursor: cursor,
    });
    if (response.object !== 'list') {
      throw new Error(`Property ${propertyId} on ${pageId} is not a relation list`);
    }

    for (const item of response.results) {
      if (item.type === 'relation') {
        ids.push(item.relation.id);
      }
    }

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return ids;
}
