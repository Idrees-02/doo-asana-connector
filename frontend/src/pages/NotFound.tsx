import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { EmptyState, Panel } from '@/components/ui';

export function NotFound() {
  return (
    <div className="mx-auto max-w-lg">
      <Panel>
        <EmptyState
          icon={Compass}
          title="Page not found"
          description="That route does not exist in this console."
          action={
            <Link
              to="/"
              className="inline-flex h-9 items-center rounded-(--radius-md) bg-(--color-accent) px-3.5 text-sm font-medium text-white hover:bg-(--color-accent-hover)"
            >
              Back to Overview
            </Link>
          }
        />
      </Panel>
    </div>
  );
}
