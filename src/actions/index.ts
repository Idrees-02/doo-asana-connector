/**
 * The action registry.
 *
 * This array is the single source of truth for what the connector can do.
 * The manifest, the OpenAPI document, the HTTP API's generic route, the MCP
 * tool list and the console's action pages all derive from it — nothing
 * enumerates the actions by hand, so none of them can drift out of sync.
 *
 * The five ids are fixed by the assignment and must never be renamed.
 */

import { addCommentAction } from './add-comment.js';
import { createTaskAction } from './create-task.js';
import { listProjectTasksAction } from './list-project-tasks.js';
import { listProjectsAction } from './list-projects.js';
import { updateTaskAction } from './update-task.js';
import { asAnyAction, type AnyConnectorAction } from './types.js';

/** The five required actions, in the order the assignment lists them. */
export const ACTIONS: readonly AnyConnectorAction[] = [
  asAnyAction(listProjectsAction),
  asAnyAction(listProjectTasksAction),
  asAnyAction(createTaskAction),
  asAnyAction(updateTaskAction),
  asAnyAction(addCommentAction),
];

/**
 * The required action ids, stated literally.
 *
 * Duplicating the ids here looks redundant, but it is deliberate: a test
 * asserts this list matches the registry exactly, so an accidental rename or
 * removal of a required action fails the build rather than silently shipping.
 */
export const REQUIRED_ACTION_IDS = [
  'asana.list_projects',
  'asana.list_project_tasks',
  'asana.create_task',
  'asana.update_task',
  'asana.add_comment',
] as const;

export type RequiredActionId = (typeof REQUIRED_ACTION_IDS)[number];

const ACTION_INDEX: ReadonlyMap<string, AnyConnectorAction> = new Map(
  ACTIONS.map((action) => [action.id, action]),
);

export function getAction(id: string): AnyConnectorAction | undefined {
  return ACTION_INDEX.get(id);
}

export function listActions(): readonly AnyConnectorAction[] {
  return ACTIONS;
}

export function listActionIds(): readonly string[] {
  return ACTIONS.map((a) => a.id);
}

export {
  addCommentAction,
  createTaskAction,
  listProjectTasksAction,
  listProjectsAction,
  updateTaskAction,
};
export type { AnyConnectorAction };
