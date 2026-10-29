import { createFileRoute } from '@tanstack/react-router';
import { App } from '../app';

// The root consumes only the exact raw reset path. Normalized lookalikes still
// enter the session gate and the ordinary unknown-path replacement.
export const Route = createFileRoute('/account/reset-password')({ component: App });
