import type { z } from 'zod';
import type { devicePlatformSchema, deviceTransportSchema } from './schemas.js';

export type DevicePlatform = z.infer<typeof devicePlatformSchema>;
export type DeviceTransport = z.infer<typeof deviceTransportSchema>;

export type PlanTier = 'free' | 'starter' | 'growth' | 'max';

/**
 * Per-channel branding the client renders instead of our own.
 *
 * `label` and not `channel`: this is the push payload, and every phone already
 * running a shipped build decodes that key. Renaming it would blank the sender
 * name on every notification until the last old install was replaced.
 */
export interface Branding {
  label: string;
  ref: string;
  icon_url: string | null;
  accent_color: string | null;
  is_sandbox: boolean;
}
