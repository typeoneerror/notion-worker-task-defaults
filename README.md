# Notion Worker: Task Defaults

A [Notion Worker](https://developers.notion.com/workers/get-started/overview.md) that fills a project with a set of default tasks.

Each project points at a **template** page. The template has a relation to a list of **default** tasks. When the worker runs for a project, it creates one task per default, copying the default's title, icon, and owners, and dating each task relative to the project's date. Afterwards it clears the template from the project so it doesn't run twice.

The worker exposes two capabilities:

- `loadDefaultTasks` — a webhook, meant to be called from a Notion automation (either a database automation or from a button property) on the Projects database.
- `createDefaultTasks` — a tool that Custom Agents (or you, via `ntn workers exec`) can call with a `projectId` and an optional `templateId`. It returns the tasks it created.

## How it works

1. Load the project page.
2. Pick the template: the `templateId` passed to the tool, otherwise the single page in the project's `Template` relation, otherwise `DEFAULT_TASK_TEMPLATE_ID`.
3. Load every page in the template's `Defaults` relation.
4. For each default, create a task in the Tasks data source with:
   - the default's title and icon (uploaded image icons can't be copied and are skipped),
   - the default's owners as the task's assignees,
   - a relation back to the project,
   - a date that starts `Date Offset` days after the project's `Date` and spans `Date Range` days (including the start day). If the project has no date, today is used.
5. Clear the project's `Template` relation.

## Requirements

- Node.js 22 or later and npm 10.9.2 or later
- The `ntn` CLI, logged in to your workspace with `ntn login`
- Three Notion databases:
  - **Projects** with a `Template` relation (to Templates) and a `Date` date property
  - **Templates** with a `Defaults` relation (to the default tasks)
  - **Tasks** with a title property, a `Project` relation, an `Assignee` person property, and a `Date` date property

  The default tasks are expected to have a title, an `Assignee` person property, and `Date Offset` and `Date Range` number properties. All property names can be changed with environment variables (see [Options](#options)).

## Setup

### 1. Clone the repo

```shell
git clone git@github.com:typeoneerror/notion-worker-task-defaults.git
cd notion-worker-task-defaults
npm install
```

### 2. Create a personal access token

The webhook isn't called by a Custom Agent, so it needs its own API token.

1. [Create a personal access token (PAT)](https://developers.notion.com/guides/get-started/personal-access-tokens).
2. Copy the token. You'll set it as `NOTION_API_TOKEN` below.

### 3. Configure environment variables

For local runs, put the variables in a `.env` file in the project root:

```shell
NOTION_API_TOKEN=secret_...
TASKS_DATA_SOURCE_ID=...
LOAD_DEFAULT_TASKS_WEBHOOK_SECRET=some-long-random-string
DEFAULT_TASK_TEMPLATE_ID=...
TIMEZONE=America/New_York
```

`.env` is loaded automatically by `ntn workers exec --local`. The deployed worker doesn't read it, so set the values remotely with `ntn`. Either set them one at a time:

```shell
ntn workers env set TASKS_DATA_SOURCE_ID=your-data-source-id
```

or push the whole `.env` file at once:

```shell
ntn workers env push
```

Check what's set on the deployed worker with:

```shell
ntn workers env list
```

### 4. Deploy

```shell
npm run check         # type-check
ntn workers deploy    # build and publish the worker
```

Get the webhook's URL with:

```shell
ntn workers webhooks list
```

### 5. Call the webhook from Notion

On the Projects database, add an automation (for example, "when Template is edited") with a **Send webhook** action:

- **URL:** the `loadDefaultTasks` URL from `ntn workers webhooks list`
- **Header:** `x-load-default-tasks-secret` set to the same value as `LOAD_DEFAULT_TASKS_WEBHOOK_SECRET`

The worker rejects any request without that header. (Note this is horribly insecure as Notion stores headers in Webhook steps in plain text.)

## Running the tool

Run the tool locally against a project (this creates real tasks):

```shell
ntn workers exec createDefaultTasks --local -d '{"projectId": "<project-page-id>", "templateId": null}'
```

Leave off `--local` to run it on the deployed worker. The tool returns the created tasks:

```json
{
  "tasks": [
    {
      "id": "…",
      "title": "Kickoff call",
      "date": { "start": "2026-10-31", "end": "2026-11-01" }
    }
  ]
}
```

`end` is `null` for tasks with a `Date Range` of 1 or less.

## Options

### Required

- `NOTION_API_TOKEN` — token for the Notion connection the worker uses. Needed for the webhook. (A Custom Agent calling the tool provides its own.)
- `TASKS_DATA_SOURCE_ID` — data source ID of the Tasks database that new tasks are created in. If you only have the database ID, run `ntn datasources resolve <database-id>`.
- `LOAD_DEFAULT_TASKS_WEBHOOK_SECRET` — shared secret that must be sent in the `x-load-default-tasks-secret` header when calling the webhook.

### Templates

- `DEFAULT_TASK_TEMPLATE_ID` — template page to use when no `templateId` is passed and the project has no template. If it isn't set, those projects fail with an error.
- `TASKS_TEMPLATE_ID` — Notion page template applied to each new task. `none` (default) uses no template, `default` uses the Tasks database's default template, or set a template page ID.

### Dates

- `TIMEZONE` — IANA timezone (for example `America/New_York`) used to decide what "today" is and to turn date-times into calendar dates. Default: `UTC`.

### Property names

Projects database:

- `PROJECTS_PROPERTY_TEMPLATE` — relation to the template to load. Default: `Template`.
- `PROJECTS_PROPERTY_DATE` — date that task dates are offset from. Default: `Date`.

Templates database:

- `PROJECTS_PROPERTY_DEFAULTS` — relation from the template to its default tasks. Default: `Defaults`.

Default tasks:

- `DEFAULTS_PROPERTY_DATE_OFFSET` — number of days after the project date that the task starts. Blank means `0`. Default: `Date Offset`.
- `DEFAULTS_PROPERTY_DATE_RANGE` — number of days the task spans, including the start day. Blank means `1`. Default: `Date Range`.

Tasks database:

- `TASKS_PROPERTY_PROJECT` — relation back to the project. Default: `Project`.
- `TASKS_PROPERTY_ASSIGNEE` — person property set to the default's owners. Default: `Assignee`.
- `TASKS_PROPERTY_DATE` — date property set from the offset and range. Default: `Date`.

The title property is detected automatically, so it doesn't need a setting.

## Development

- `npm run check` — type-check without building
- `npm run build` — compile to `dist/`
- `ntn workers runs list` and `ntn workers runs logs <runId>` — inspect deployed runs

## Todo

- [ ] Task template support
- [ ] Add additional properties from shared properties
- [ ] Copy page body from template
