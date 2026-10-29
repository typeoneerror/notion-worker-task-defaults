import { Client } from '@notionhq/client';
import { WebhookVerificationError } from '@notionhq/workers';
import { addDays, format, parseISO } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';

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
  notion: Client,
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

export type DateRange = { start: string; end: string | null };

// The yyyy-MM-dd date of a Notion date value in the given timezone, or today if there isn't one
export function getCalendarDate(timeZone: string, value?: string | null): string {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  return formatInTimeZone(value ? new Date(value) : new Date(), timeZone, 'yyyy-MM-dd');
}

// Starts `offset` days after the base date and spans `range` days, including the start day
export function getDateRange(baseDate: string, offset: number, range: number): DateRange {
  const start = addDays(parseISO(baseDate), offset);
  const end = range > 1 ? addDays(start, range - 1) : null;

  return {
    start: format(start, 'yyyy-MM-dd'),
    end: end ? format(end, 'yyyy-MM-dd') : null,
  };
}
