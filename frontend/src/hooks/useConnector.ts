/**
 * Data hooks over the connector API.
 *
 * Centralising these keeps query keys consistent (so invalidation actually
 * works) and puts the write-safety rules in one place rather than in every
 * form that happens to call a mutation.
 */

import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { api, ApiError } from '@/services/api';
import { useToast } from '@/components/ui/Toast';
import type {
  AddCommentResult,
  CreateTaskResult,
  ExecutionEnvelope,
  ListProjectsResult,
  ListTasksResult,
  UpdateTaskResult,
} from '@/types/api';

/* -------------------------------------------------------------------------- */
/* Query keys                                                                  */
/* -------------------------------------------------------------------------- */

export const keys = {
  status: ['status'] as const,
  connection: ['connection'] as const,
  manifest: ['manifest'] as const,
  actions: ['actions'] as const,
  schema: (id: string) => ['schema', id] as const,
  projects: (cursor: string | null, archived: boolean | undefined) =>
    ['projects', cursor, archived] as const,
  tasks: (projectId: string, cursor: string | null, includeCompleted: boolean) =>
    ['tasks', projectId, cursor, includeCompleted] as const,
  activity: ['activity'] as const,
  metrics: ['metrics'] as const,
  health: ['health'] as const,
};

/**
 * Unwrap an execution envelope.
 *
 * The API returns HTTP 200 with `ok: false` only for domain failures that map
 * to 200; everything else already threw. This converts a remaining `ok: false`
 * into the same ApiError type, so callers handle exactly one error shape.
 */
function unwrap<T>(envelope: ExecutionEnvelope<T>): T {
  if (!envelope.ok) throw new ApiError(envelope.error, 200);
  return envelope.data;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export function useStatus() {
  return useQuery({
    queryKey: keys.status,
    queryFn: ({ signal }) => api.getStatus(signal),
    retry: false,
  });
}

export function useConnection() {
  return useQuery({
    queryKey: keys.connection,
    queryFn: ({ signal }) => api.testConnection(signal),
    retry: false,
  });
}

export function useActions() {
  return useQuery({
    queryKey: keys.actions,
    queryFn: ({ signal }) => api.getActions(signal),
    // The action list is fixed for the life of the process.
    staleTime: Infinity,
  });
}

export function useManifest() {
  return useQuery({
    queryKey: keys.manifest,
    queryFn: ({ signal }) => api.getManifest(signal),
    staleTime: Infinity,
  });
}

export function useSchema(actionId: string | null) {
  return useQuery({
    queryKey: keys.schema(actionId ?? ''),
    queryFn: ({ signal }) => api.getSchema(actionId ?? '', signal),
    enabled: actionId !== null,
    staleTime: Infinity,
  });
}

export function useProjects(options: { cursor?: string | null; archived?: boolean } = {}) {
  const cursor = options.cursor ?? null;

  return useQuery({
    queryKey: keys.projects(cursor, options.archived),
    queryFn: async ({ signal }) => {
      const input: Record<string, unknown> = { limit: 50 };
      if (cursor !== null) input['cursor'] = cursor;
      if (options.archived !== undefined) input['archived'] = options.archived;

      return unwrap(
        await api.execute<ListProjectsResult>('asana.list_projects', input, { signal }),
      );
    },
  });
}

export function useProjectTasks(
  projectId: string | null,
  options: { cursor?: string | null; includeCompleted?: boolean } = {},
) {
  const cursor = options.cursor ?? null;
  const includeCompleted = options.includeCompleted ?? true;

  return useQuery({
    queryKey: keys.tasks(projectId ?? '', cursor, includeCompleted),
    enabled: projectId !== null,
    queryFn: async ({ signal }) => {
      const input: Record<string, unknown> = { projectId, limit: 50, includeCompleted };
      if (cursor !== null) input['cursor'] = cursor;

      return unwrap(
        await api.execute<ListTasksResult>('asana.list_project_tasks', input, { signal }),
      );
    },
  });
}

export function useActivity(limit = 50) {
  return useQuery({
    queryKey: [...keys.activity, limit],
    queryFn: ({ signal }) => api.getActivity({ limit }, signal),
    refetchInterval: 10_000,
  });
}

export function useMetrics() {
  return useQuery({
    queryKey: keys.metrics,
    queryFn: ({ signal }) => api.getMetrics(signal),
    refetchInterval: 15_000,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: keys.health,
    queryFn: ({ signal }) => api.getHealth(signal),
    retry: false,
  });
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Shared behaviour for the three write actions.
 *
 * Every write:
 *   - passes `approved: true` explicitly, because the user pressing a clearly
 *     labelled button IS the approval the connector's gate is asking for
 *   - carries an idempotency key, so a double submit or a user-initiated
 *     retry cannot create a duplicate
 *   - never retries automatically (configured globally on mutations)
 *   - reports the request id in the toast, so a failure is traceable in Activity
 */
function useWriteAction<TResult>(
  actionId: string,
  options: {
    successTitle: (result: TResult) => string;
    successDescription?: (result: TResult) => string;
    invalidate?: readonly unknown[][];
  },
): UseMutationResult<TResult, Error, Record<string, unknown>> {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (input: Record<string, unknown>) => {
      // A fresh key per submission: it makes THIS submission safe to retry,
      // without silently swallowing a genuinely-intended second write.
      const idempotencyKey = `${actionId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      const envelope = await api.execute<TResult>(actionId, input, {
        approved: true,
        idempotencyKey,
      });

      if (!envelope.ok) throw new ApiError(envelope.error, 200);
      return envelope.data;
    },

    onSuccess: (result) => {
      toast({
        tone: 'success',
        title: options.successTitle(result),
        ...(options.successDescription === undefined
          ? {}
          : { description: options.successDescription(result) }),
      });

      for (const key of options.invalidate ?? []) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      void queryClient.invalidateQueries({ queryKey: keys.activity });
      void queryClient.invalidateQueries({ queryKey: keys.metrics });
    },

    onError: (error) => {
      const apiError = error instanceof ApiError ? error : null;

      toast({
        tone: 'error',
        title: apiError?.needsManualRetry === true ? 'Write may be incomplete' : 'Action failed',
        description:
          apiError?.needsManualRetry === true
            ? 'This may already have been applied in Asana. Check before retrying — retrying blindly can create a duplicate.'
            : (apiError?.guidance ?? error.message),
        ...(apiError === null ? {} : { meta: apiError.payload.requestId }),
      });
    },
  });
}

export function useCreateTask() {
  return useWriteAction<CreateTaskResult>('asana.create_task', {
    successTitle: (result) => `Created "${result.task.name ?? 'task'}"`,
    successDescription: (result) => `Task ${result.task.id}`,
    invalidate: [['tasks']],
  });
}

export function useUpdateTask() {
  return useWriteAction<UpdateTaskResult>('asana.update_task', {
    successTitle: () => 'Task updated successfully',
    successDescription: (result) =>
      result.updatedFields.length > 0
        ? `Updated: ${result.updatedFields.join(', ')}`
        : 'No fields changed',
    invalidate: [['tasks']],
  });
}

export function useAddComment() {
  return useWriteAction<AddCommentResult>('asana.add_comment', {
    successTitle: () => 'Comment added',
    invalidate: [['tasks']],
  });
}
