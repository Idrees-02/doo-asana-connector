/**
 * The action registry.
 *
 * This array is the single source of truth for what the connector can do.
 * The manifest, the OpenAPI document, the HTTP API's generic route, the MCP
 * tool list and the console's action pages all derive from it — nothing
 * enumerates the actions by hand, so none of them can drift out of sync.
 *
 * The five assignment-required ids come first and must never be renamed,
 * removed or reordered relative to each other. Everything after them is
 * additive.
 */

import { addCommentAction } from './add-comment.js';
import { createTaskAction } from './create-task.js';
import { listProjectTasksAction } from './list-project-tasks.js';
import { listProjectsAction } from './list-projects.js';
import { updateTaskAction } from './update-task.js';

import {
  addTaskToProjectAction,
  assignTaskAction,
  completeTaskAction,
  createSubtaskAction,
  getTaskAction,
  listSubtasksAction,
  listTasksAction,
  removeTaskFromProjectAction,
  reopenTaskAction,
  searchTasksAction,
  setTaskDescriptionAction,
  setTaskDueDateAction,
} from './tasks-extra.js';

import {
  addProjectMemberAction,
  createProjectAction,
  createSectionAction,
  getProjectAction,
  listProjectMembersAction,
  listProjectSectionsAction,
  moveTaskToSectionAction,
  removeProjectMemberAction,
  updateProjectAction,
  updateSectionAction,
} from './projects-extra.js';

import {
  addTagToTaskAction,
  createTagAction,
  getCurrentUserAction,
  getUserAction,
  listCommentsAction,
  listTagsAction,
  listUsersAction,
  removeTagFromTaskAction,
} from './directory.js';

import { asAnyAction, type AnyConnectorAction } from './types.js';

/**
 * The five required actions, in the order the assignment lists them.
 *
 * Kept as their own array so the guarantee is visible in the code, not just
 * in a test.
 */
const REQUIRED_ACTIONS: readonly AnyConnectorAction[] = [
  asAnyAction(listProjectsAction),
  asAnyAction(listProjectTasksAction),
  asAnyAction(createTaskAction),
  asAnyAction(updateTaskAction),
  asAnyAction(addCommentAction),
];

/** Additional actions. Additive only — none of these may shadow a required id. */
const EXTENDED_ACTIONS: readonly AnyConnectorAction[] = [
  // Tasks
  asAnyAction(getTaskAction),
  asAnyAction(listTasksAction),
  asAnyAction(searchTasksAction),
  asAnyAction(completeTaskAction),
  asAnyAction(reopenTaskAction),
  asAnyAction(assignTaskAction),
  asAnyAction(setTaskDueDateAction),
  asAnyAction(setTaskDescriptionAction),
  asAnyAction(createSubtaskAction),
  asAnyAction(listSubtasksAction),
  asAnyAction(addTaskToProjectAction),
  asAnyAction(removeTaskFromProjectAction),

  // Projects
  asAnyAction(getProjectAction),
  asAnyAction(createProjectAction),
  asAnyAction(updateProjectAction),
  asAnyAction(listProjectMembersAction),
  asAnyAction(addProjectMemberAction),
  asAnyAction(removeProjectMemberAction),

  // Sections
  asAnyAction(listProjectSectionsAction),
  asAnyAction(createSectionAction),
  asAnyAction(updateSectionAction),
  asAnyAction(moveTaskToSectionAction),

  // Users
  asAnyAction(getCurrentUserAction),
  asAnyAction(getUserAction),
  asAnyAction(listUsersAction),

  // Comments
  asAnyAction(listCommentsAction),

  // Tags
  asAnyAction(listTagsAction),
  asAnyAction(createTagAction),
  asAnyAction(addTagToTaskAction),
  asAnyAction(removeTagFromTaskAction),
];

export const ACTIONS: readonly AnyConnectorAction[] = [...REQUIRED_ACTIONS, ...EXTENDED_ACTIONS];

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

/*
 * Fail fast on a duplicate id at module load.
 *
 * A duplicate would silently shadow an action in the Map — including a
 * required one — and the symptom would be a missing tool rather than an
 * obvious error.
 */
if (ACTION_INDEX.size !== ACTIONS.length) {
  const seen = new Set<string>();
  const duplicates = ACTIONS.map((a) => a.id).filter((id) => !seen.add(id));
  throw new Error(`Duplicate action id(s) in the registry: ${duplicates.join(', ')}`);
}

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
