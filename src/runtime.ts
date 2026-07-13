import { KeyringSecretStore, type SecretStore } from "./auth/tokenStore.js";
import { OfficialBrowserAuthenticator, type BrowserAuthenticator } from "./auth/browserAuth.js";
import { ApiClient } from "./api.js";
import { ProfileVault } from "./config/vault.js";
import { ProfileWizard } from "./config/wizard.js";
import { DiscoveryService } from "./discovery.js";
import { Session } from "./session.js";
import type { ToolContext } from "./tools/shared.js";

export function createRuntime(options: { secrets?: SecretStore; browserAuth?: BrowserAuthenticator; api?: ApiClient } = {}): ToolContext {
  const secrets = options.secrets ?? new KeyringSecretStore();
  const browserAuth = options.browserAuth ?? new OfficialBrowserAuthenticator();
  const session = new Session(secrets, browserAuth, options.api ?? new ApiClient());
  const vault = new ProfileVault(secrets);
  const discovery = new DiscoveryService(session);
  const wizard = new ProfileWizard(discovery, vault);
  return { session, vault, discovery, wizard };
}
