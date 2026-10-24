import { defineConfig } from '@neon/config/v1';

export default defineConfig({
  // Declare your Neon services here
  auth: true,
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.name === 'staging') {
      // Omission must not be relied on to clear an existing expiry: operators
      // must clear expires_at before adopting an existing staging branch.
      return {};
    }
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run `neon checkout <name>` to create a new branch with these settings
      return { ttl: '7d' };
    }
    // Existing branch: no changes
    return {};
  },
});
