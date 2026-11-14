import type { BackendConfig } from './webhook.js';

export function onboarding(env: BackendConfig): Response {
  const slug = /^[a-zA-Z0-9-]+$/.test(env.GITHUB_APP_SLUG) ? env.GITHUB_APP_SLUG : 'codexbot';
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Set up CodexBot</title>
<style>body{font:18px/1.6 system-ui;max-width:760px;margin:64px auto;padding:0 24px;color:#182026;background:#faf9f6}h1{font-size:44px;letter-spacing:-1px}a{color:#134f40}code{background:#e9ede8;padding:3px 6px}li{margin:20px 0}</style>
<main><p>CODEXBOT · CLI-ASSISTED SETUP</p><h1>Your repository. Your review.</h1><p>Reviews run on your GitHub Actions runners, using your own credentials. This service never receives your plaintext OpenAI credentials. This page is a checklist; account connection runs in the local CLI, not a hosted web wizard.</p>
<ol><li><a href="https://github.com/apps/${slug}/installations/new">Install the GitHub App</a> and select repositories.</li>
<li>Use the source repository's CLI: <code>npm run cli -- setup --repository OWNER/REPO --backend WORKER_URL --source OWNER/CODEXBOT --ref FULL_COMMIT_SHA</code>. It opens a setup pull request for you to review. The default App permission profile omits Workflows write: use the documented manual installation or explicit temporary <code>--setup-as-user</code> fallback unless your operator has obtained a permission upgrade.</li>
<li>Choose ChatGPT or API-key authentication. <strong>Continue with ChatGPT</strong> uses the local CLI's official browser sign-in with a loopback callback. Run <code>npm run cli -- connect --repository OWNER/REPO --backend WORKER_URL</code>. For API-key mode use <code>connect-api-key</code>.</li>
<li>Protect the default branch and the per-user credential Environment before connecting credentials. Private repositories require GitHub Pro, Team or Enterprise Environment support; the CLI probes this feature and never substitutes repository secrets. Merge the setup PR, then comment <code>@codexbot review</code>. Configure another alphanumeric handle in <code>.codexbot.yml</code>. Aliases are text commands and may notify an unrelated GitHub user with that name.</li></ol>
<p>ChatGPT deployment authorization: <strong>${env.CHATGPT_DEPLOYMENT_AUTHORIZED === 'true' ? 'operator attested' : 'disabled pending eligibility / hosted approval'}</strong>. Hosted plan usage requires OpenAI approval. Local OSS sign-in is not a hosted OAuth callback.</p>
<p>Automatic reviews are opt-in. Merge authorization is separate and disabled by default. API billing is separate from ChatGPT plan usage; there is no automatic fallback.</p></main></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
