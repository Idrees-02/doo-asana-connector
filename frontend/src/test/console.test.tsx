/**
 * Console tests.
 *
 * Covers the states the brief requires: loading, success, empty, error,
 * authentication failure, rate limiting, validation, and mobile navigation.
 *
 * The write-safety tests matter most — they assert that the UI cannot create
 * data without approval and warns correctly when a write may have half-applied.
 * There is deliberately no delete test, because there is no delete feature.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';

import { errorEnvelope, mockProject, mockTask, server, successEnvelope } from './msw';
import { ToastProvider } from '@/components/ui/Toast';
import { Overview } from '@/pages/Overview';
import { Projects } from '@/pages/Projects';
import { Tasks } from '@/pages/Tasks';
import { Actions } from '@/pages/Actions';
import { DemoBanner } from '@/components/layout/DemoBanner';
import { AppShell } from '@/components/layout/AppShell';
import { CreateTaskDialog } from '@/components/tasks/CreateTaskDialog';
import { ErrorState } from '@/components/ui';

function renderPage(ui: ReactNode, route = '/') {
  const queryClient = new QueryClient({
    defaultOptions: {
      // No retries in tests: an error state should appear immediately rather
      // than after backoff, and retries make failures slow and flaky.
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/* ========================================================================== */
/* Demo mode                                                                   */
/* ========================================================================== */

describe('demo mode labelling', () => {
  it('shows an unmissable banner so synthetic data is never mistaken for real', async () => {
    renderPage(<DemoBanner />);

    expect(await screen.findByText('DEMO MODE')).toBeInTheDocument();
    expect(
      screen.getByText(/synthetic and is not from a real Asana workspace/i),
    ).toBeInTheDocument();
  });

  it('has no dismiss control — a dismissed banner would make demo data look real', async () => {
    const { container } = renderPage(<DemoBanner />);
    await screen.findByText('DEMO MODE');

    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('hides the banner when the connector is live', async () => {
    server.use(
      http.get('/api/connector/status', () =>
        HttpResponse.json({
          connector: { name: 'a', displayName: 'A', version: '1', provider: 'asana', builder: 'I' },
          config: {
            mode: 'live',
            modeReason: 'PAT found.',
            nodeEnv: 'test',
            asana: { baseUrl: '', rateLimitRpm: 140, timeoutMs: 1, maxConcurrency: 1, defaultWorkspace: null },
            auth: { patConfigured: true, oauthConfigured: false, oauthRedirectUri: null, oauthScopes: [], credentialFingerprint: 'fp_x' },
            server: { port: 8787, corsOrigin: '' },
            mcp: { transport: 'stdio', httpPort: 8788 },
            credentialEncryptionEnabled: false,
          },
          demoMode: false,
          demoControls: null,
          client: { totalRequests: 0, totalRetries: 0, rateLimitHits: 0, inFlight: 0 },
        }),
      ),
    );

    renderPage(<DemoBanner />);
    await waitFor(() => expect(screen.queryByText('DEMO MODE')).not.toBeInTheDocument());
  });
});

/* ========================================================================== */
/* Overview                                                                    */
/* ========================================================================== */

describe('Overview', () => {
  it('renders connector status tiles', async () => {
    renderPage(<Overview />);

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(await screen.findByText('Connector')).toBeInTheDocument();
    expect(await screen.findByText('MCP Adapter')).toBeInTheDocument();
  });

  it('distinguishes "no requests yet" from "everything failed"', async () => {
    // Showing a plausible 0% success rate when nothing has run would be a
    // fabricated metric, which the brief explicitly forbids.
    renderPage(<Overview />);

    expect(await screen.findByText('No requests yet')).toBeInTheDocument();
  });
});

/* ========================================================================== */
/* Projects                                                                    */
/* ========================================================================== */

describe('Projects', () => {
  it('shows a loading state, then the loaded projects', async () => {
    renderPage(<Projects />);

    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();

    // Desktop table and mobile cards both render; CSS hides one. Scope the
    // assertion to the table so it is unambiguous which view is under test.
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('Product Launch')).toBeInTheDocument();
  });

  it('filters loaded projects as the user types', async () => {
    const user = userEvent.setup();
    renderPage(<Projects />);
    await screen.findAllByText('Product Launch');

    await user.type(screen.getByLabelText('Filter projects'), 'nonexistent');

    expect(await screen.findByText('No projects match your filter')).toBeInTheDocument();
  });

  it('shows an empty state when the workspace has no projects', async () => {
    server.use(
      http.post('/api/actions/asana.list_projects', () =>
        HttpResponse.json(
          successEnvelope({
            projects: [],
            workspace: null,
            pagination: { nextCursor: null, hasMore: false, pageSize: 50, returned: 0 },
          }),
        ),
      ),
    );

    renderPage(<Projects />);
    expect(await screen.findByText('No projects found')).toBeInTheDocument();
  });

  it('surfaces an authentication failure with actionable guidance', async () => {
    server.use(
      http.post('/api/actions/asana.list_projects', () =>
        HttpResponse.json(
          errorEnvelope('ASANA_AUTHENTICATION_ERROR', {
            message: 'Asana authentication is invalid or expired.',
            guidance: 'Generate a new Personal Access Token and update .env.',
            httpStatus: 401,
          }),
          { status: 401 },
        ),
      ),
    );

    renderPage(<Projects />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('ASANA_AUTHENTICATION_ERROR')).toBeInTheDocument();
    expect(within(alert).getByText(/generate a new personal access token/i)).toBeInTheDocument();
    // The request id makes the failure traceable in Activity.
    expect(within(alert).getByText('req_test123')).toBeInTheDocument();
  });

  it('surfaces a rate-limit failure', async () => {
    server.use(
      http.post('/api/actions/asana.list_projects', () =>
        HttpResponse.json(
          errorEnvelope('ASANA_RATE_LIMITED', {
            message: 'Asana rate limit exceeded.',
            guidance: 'Wait before retrying — rejected requests still count against the quota.',
            retryable: true,
            retryStrategy: 'after_delay',
            httpStatus: 429,
          }),
          { status: 429 },
        ),
      ),
    );

    renderPage(<Projects />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('ASANA_RATE_LIMITED')).toBeInTheDocument();
    expect(within(alert).getByText(/still count against the quota/i)).toBeInTheDocument();
  });

  it('paginates only when the API reports more results', async () => {
    renderPage(<Projects />);
    await screen.findAllByText('Product Launch');

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });
});

/* ========================================================================== */
/* Tasks and write safety                                                      */
/* ========================================================================== */

describe('Tasks', () => {
  it('lists tasks with assignee and due date', async () => {
    renderPage(<Tasks />, '/tasks/900000000001001');

    const table = await screen.findByRole('table');
    expect(await within(table).findByText('Prepare launch documentation')).toBeInTheDocument();
    expect(within(table).getByText('Idrees Khaled')).toBeInTheDocument();
  });

  it('opens the task drawer with details and a comment composer', async () => {
    const user = userEvent.setup();
    renderPage(<Tasks />, '/tasks/900000000001001');

    const table = await screen.findByRole('table');
    await user.click(await within(table).findByText('Prepare launch documentation'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Comments')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/add a comment/i)).toBeInTheDocument();
  });
});

describe('write safety in the UI', () => {
  it('disables submit until a task name is entered', async () => {
    renderPage(
      <CreateTaskDialog projectId={mockProject.id} projects={[mockProject]} onClose={() => {}} />,
    );

    expect(await screen.findByRole('button', { name: 'Create task' })).toBeDisabled();
  });

  it('warns that Asana does not deduplicate before the user submits', async () => {
    renderPage(
      <CreateTaskDialog projectId={mockProject.id} projects={[mockProject]} onClose={() => {}} />,
    );

    expect(await screen.findByText(/does not deduplicate tasks/i)).toBeInTheDocument();
  });

  it('sends approved:true and an idempotency key on create', async () => {
    let received: Record<string, unknown> | null = null;

    server.use(
      http.post('/api/actions/asana.create_task', async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          successEnvelope({ task: mockTask, created: true }, 'asana.create_task'),
        );
      }),
    );

    const user = userEvent.setup();
    renderPage(
      <CreateTaskDialog projectId={mockProject.id} projects={[mockProject]} onClose={() => {}} />,
    );

    await user.type(await screen.findByLabelText(/task name/i), 'New task');
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    await waitFor(() => expect(received).not.toBeNull());

    // Approval is the connector's gate; the UI must satisfy it explicitly.
    expect(received!['approved']).toBe(true);
    // And every submission carries a key, so retrying it cannot duplicate.
    expect(received!['idempotencyKey']).toEqual(expect.stringContaining('asana.create_task'));
  });

  it('shows the created task identity rather than a bare success message', async () => {
    server.use(
      http.post('/api/actions/asana.create_task', () =>
        HttpResponse.json(
          successEnvelope({ task: mockTask, created: true }, 'asana.create_task'),
        ),
      ),
    );

    const user = userEvent.setup();
    renderPage(
      <CreateTaskDialog projectId={mockProject.id} projects={[mockProject]} onClose={() => {}} />,
    );

    await user.type(await screen.findByLabelText(/task name/i), 'New task');
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    expect(await screen.findByText('Task created')).toBeInTheDocument();
    expect(screen.getByText(mockTask.id)).toBeInTheDocument();
  });

  it('warns prominently when a write may have half-applied', () => {
    // The most consequential message the console can show.
    renderPage(
      <ErrorState
        message="The request to Asana timed out."
        code="ASANA_TIMEOUT"
        needsManualRetry
        onRetry={() => {}}
      />,
    );

    expect(screen.getByText(/may already have been applied/i)).toBeInTheDocument();
    // And no retry button, so the user cannot casually duplicate the write.
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('offers retry for failures that are genuinely safe to repeat', () => {
    renderPage(<ErrorState message="Temporary failure." code="ASANA_SERVER_ERROR" onRetry={() => {}} />);

    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

/* ========================================================================== */
/* Actions                                                                     */
/* ========================================================================== */

describe('Action Center', () => {
  it('lists the five required actions with their exact ids', async () => {
    server.use(
      http.get('/api/connector/actions', () =>
        HttpResponse.json({
          actions: [
            'asana.list_projects',
            'asana.list_project_tasks',
            'asana.create_task',
            'asana.update_task',
            'asana.add_comment',
          ].map((id, index) => ({
            id,
            name: id,
            description: 'Test action',
            category: 'tasks',
            type: index < 2 ? 'read' : 'write',
            safety: {
              write: index >= 2,
              idempotent: index !== 2 && index !== 4,
              risk: index < 2 ? 'low' : 'medium',
              requiresApproval: index >= 2,
              duplicateBehavior: 'Duplicate behaviour described here for the card.',
              retryBehavior: 'Retry behaviour described here for the card.',
              idempotencyBehavior: 'Idempotency behaviour described here for the card.',
            },
            supportsPagination: index < 2,
            scopes: ['tasks:read'],
            endpoints: ['GET /tasks'],
            examples: [],
          })),
        }),
      ),
    );

    renderPage(<Actions />);

    for (const id of [
      'asana.list_projects',
      'asana.list_project_tasks',
      'asana.create_task',
      'asana.update_task',
      'asana.add_comment',
    ]) {
      // Each id appears as both the card heading and the technical id.
      expect((await screen.findAllByText(id)).length).toBeGreaterThan(0);
    }
  });

  it('never shows a delete action', async () => {
    renderPage(<Actions />);
    await waitFor(() => {
      expect(screen.queryByText(/delete/i)).not.toBeInTheDocument();
    });
  });
});

/* ========================================================================== */
/* Navigation and accessibility                                                */
/* ========================================================================== */

describe('navigation', () => {
  it('provides both desktop and mobile navigation landmarks', async () => {
    renderPage(
      <AppShell>
        <p>content</p>
      </AppShell>,
    );

    expect(await screen.findByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    // The mobile bottom bar is a separate element, not a shrunken sidebar.
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
  });

  it('opens and closes the mobile navigation sheet', async () => {
    const user = userEvent.setup();
    renderPage(
      <AppShell>
        <p>content</p>
      </AppShell>,
    );

    await user.click(screen.getByRole('button', { name: 'Open navigation menu' }));

    const sheet = await screen.findByRole('dialog', { name: 'Navigation' });
    expect(sheet).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: 'Close navigation menu' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument(),
    );
  });

  it('offers a skip link for keyboard users', () => {
    renderPage(
      <AppShell>
        <p>content</p>
      </AppShell>,
    );

    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument();
  });

  it('marks up tables with a caption and column headers', async () => {
    renderPage(<Projects />);
    await screen.findAllByText('Product Launch');

    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Project' })).toBeInTheDocument();
    // A caption gives screen-reader users the table's purpose.
    expect(table.querySelector('caption')).toBeTruthy();
  });
});
