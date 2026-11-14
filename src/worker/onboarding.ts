import type { BackendConfig } from './webhook.js';
import type { BrowserSession } from './web-auth.js';
import type { Config } from '../core/config.js';
import catalog from '../core/model-catalog.json' with { type: 'json' };
export function html(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]!); }
export function page(title: string, content: string, session?: BrowserSession, canonical?: string): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${html(title)} · CodexBot</title>${canonical ? `<link rel="canonical" href="${html(canonical)}/">` : ''}<link rel="stylesheet" href="/assets/app.css"><script src="/assets/app.js" defer></script></head><body><a class="skip" href="#main">Skip to content</a><header><a class="brand" href="/">C<span>/</span>B <b>CodexBot</b></a><nav aria-label="Main"><a href="https://github.com/AppSolves/codexbot">Source</a>${session ? '<a href="/dashboard">Repositories</a><a href="/dashboard/account">Account</a>' : '<a href="/auth/github">Get started ↗</a>'}<button id="theme" type="button" aria-label="Switch color theme">◐</button></nav></header><main id="main">${content}</main><footer><span>CodexBot · Apache 2.0</span><span>Your repository. Your infrastructure.</span></footer></body></html>`, { headers: { 'Content-Type':'text/html; charset=utf-8' } });
}
export function onboarding(env: BackendConfig): Response {
  const slug = /^[a-zA-Z0-9-]+$/.test(env.GITHUB_APP_SLUG) ? env.GITHUB_APP_SLUG : 'codexbot';
  return page('Code review with context', `<section class="hero"><p class="eyebrow">AN INDEPENDENT SECOND LOOK</p><h1>The diff is small.<br>The consequences<br>might not be.</h1><div class="hero-bottom"><p>CodexBot follows changes into the code around them. Get actionable, inline pull request reviews from Codex, on your own GitHub Actions infrastructure.</p><div class="actions"><a class="button primary" href="/auth/github">Get started with GitHub ↗</a><a class="button" href="https://github.com/apps/${slug}/installations/new">Install the GitHub App</a></div></div></section><section class="example" aria-label="Example review"><div class="example-heading"><span>PR #42 · permissions.ts</span><span>Illustrative example</span></div><pre><code><span class="muted">  function canAccess(role) {</span>\n<span class="removed">−   return role === 'admin' || role === 'owner';</span>\n<span class="added">+   return role === 'admin' || 'owner';</span>\n<span class="muted">  }</span></code></pre><div class="annotation"><strong>HIGH · A truthy string grants access to every role</strong><p>The unchanged caller treats this result as an authorization decision. Compare the role explicitly on both sides.</p></div></section><section class="principles"><div><p class="eyebrow">01 / CONTEXT</p><h2>Beyond the changed lines.</h2><p>Inspect relevant callers, tests and trusted project guidance. Findings stay attached to the exact commit and changed line.</p></div><div><p class="eyebrow">02 / CONTROL</p><h2>Your account. Your policy.</h2><p>Use approved ChatGPT access or your own API key. Set who can request reviews, the model and review policy. Usage limits still apply; API billing is separate.</p></div><div><p class="eyebrow">03 / ISOLATION</p><h2>Read-only by design.</h2><p>Analysis runs in an isolated container with no network or credentials. A separate publisher validates results. Incomplete reviews never approve a PR.</p></div></section><section class="closing"><h2>A considered review.<br>A reviewable setup.</h2><p>Connect GitHub, choose a repository and review the setup PR. Branch protections remain in charge. AI reviews can miss bugs; keep your tests and human reviewers.</p><a class="button primary" href="/auth/github">Set up your repository ↗</a></section>`, undefined, env.PUBLIC_URL);
}
export function csrf(session: BrowserSession): string { return `<input type="hidden" name="csrf" value="${html(session.csrf)}">`; }
export function configurationFields(config: Config): string {
  const fields = (object: Record<string, unknown>, prefix = ''): string => Object.entries(object).map(([key,value]) => {
    const name = prefix + key, id = 'field-' + name.replaceAll('.', '-');
    if (value && typeof value === 'object' && !Array.isArray(value)) return `<fieldset><legend>${html(name.replaceAll('_',' '))}</legend>${fields(value as Record<string,unknown>, name + '.')}</fieldset>`;
    const label = html(key.replaceAll('_',' '));
    if (name === 'review.model' || name === 'review.effort') {
      const options = name === 'review.model' ? catalog.models.map(model => model.model) : [...new Set(catalog.models.flatMap(model => model.efforts))];
      if (typeof value === 'string' && !options.includes(value)) options.push(value);
      return `<label for="${id}">${label}<select id="${id}" name="${name}"><option value="">Codex default</option>${options.map(option => `<option value="${html(option)}"${value === option ? ' selected' : ''}>${html(option)}</option>`).join('')}</select></label>`;
    }
    if (typeof value === 'boolean') return `<label for="${id}"><input id="${id}" name="${name}" type="checkbox" value="true"${value ? ' checked' : ''}>${label}</label>`;
    const input = typeof value === 'number' ? `type="number" step="any" value="${value}" required` : `type="text" maxlength="4096" value="${html(Array.isArray(value) ? value.join(', ') : value ?? '')}"`;
    return `<label for="${id}">${label}<input id="${id}" name="${name}" ${input}></label>`;
  }).join('');
  return fields(config as unknown as Record<string,unknown>);
}
export const APP_JS = `document.querySelector('#theme')?.addEventListener('click',()=>{document.documentElement.dataset.theme=(document.documentElement.dataset.theme||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'))==='dark'?'light':'dark'});document.querySelectorAll('form').forEach(form=>form.addEventListener('submit',()=>form.setAttribute('aria-busy','true')));`;
export const APP_CSS = `:root{color-scheme:light;
--bg:#f5f3ed;
--fg:#202a28;
--muted:#5c6662;
--line:#cbd1c8;
--accent:#205942;
--panel:#e9ece4;
--red:#8b312f}
*{box-sizing:border-box}
body{margin:0;
background:var(--bg);
color:var(--fg);
font:16px/1.6 "Segoe UI",Arial,sans-serif}
a{color:inherit;
text-underline-offset:4px}
a:hover{color:var(--accent)}
header,footer{max-width:1280px;
margin:auto;
padding:28px 5vw;
display:flex;
justify-content:space-between;
align-items:center;
border-bottom:1px solid var(--line)}
nav{display:flex;
gap:24px;
align-items:center}
nav a{font-size:14px;
text-decoration:none}
.brand{display:flex;
align-items:center;
font:600 22px/1.2 monospace;
text-decoration:none;
gap:4px}
.brand span{color:var(--accent)}
.brand b{margin-left:12px;
font:600 17px "Segoe UI",sans-serif}
button,input,select,textarea{font:inherit}
button{cursor:pointer}
#theme{border:0;
background:none;
color:inherit;
font-size:24px;
padding:2px 10px}
main{max-width:1160px;
margin:auto;
padding:0 28px;
min-height:70vh}
h1,h2,h3,p{margin-top:0}
h1,h2{font-family:Georgia,"Times New Roman",serif;
font-weight:400;
letter-spacing:-.045em;
line-height:1.05}
h1{font-size:clamp(44px,6.5vw,88px)}
h2{font-size:36px}
h3{font-size:20px}
.eyebrow{font:12px/1.5 monospace;
letter-spacing:.13em;
color:var(--accent);
margin-bottom:28px}
.hero{padding:82px 0 52px}
.hero h1{max-width:850px}
.hero-bottom{display:grid;
grid-template-columns:1fr 1fr;
gap:80px;
align-items:start}
.hero-bottom p{font-size:19px;
max-width:480px}
.actions{display:flex;
gap:12px;
flex-wrap:wrap}
.button,button[type=submit]{display:inline-block;
padding:12px 19px;
border:1px solid var(--line);
border-radius:3px;
text-decoration:none;
font-weight:600;
background:transparent;
color:var(--fg)}
.primary,button[type=submit]{background:var(--accent);
color:#fff;
border-color:var(--accent)}
.button:hover,button[type=submit]:hover{filter:brightness(1.12)}
.primary:hover{color:#fff}
.example{margin:12px 0 70px;
border:1px solid var(--line);
background:var(--panel)}
.example-heading{display:flex;
justify-content:space-between;
padding:12px 22px;
border-bottom:1px solid var(--line);
font:12px monospace}
pre{overflow:auto;
padding:22px;
margin:0;
font:14px/1.9 monospace}
.removed{color:var(--red)}
.added{color:var(--accent)}
.muted,.hint{color:var(--muted)}
.annotation{border-left:3px solid var(--accent);
margin:0 24px 24px;
padding:14px 20px;
background:var(--bg)}
.annotation p{margin:8px 0 0}
.principles{display:grid;
grid-template-columns:repeat(3,1fr);
gap:40px;
padding:0 0 60px;
border-bottom:1px solid var(--line)}
.principles h2{font-size:29px}
.principles p:last-child{color:var(--muted)}
.closing{padding:70px 0;
max-width:650px}
.closing p{color:var(--muted)}
footer{font-size:12px;
color:var(--muted);
border-bottom:0;
border-top:1px solid var(--line)}
.page-title{padding:52px 0 30px}
.page-title h1{font-size:52px}
.layout{display:grid;
grid-template-columns:230px 1fr;
gap:54px;
padding-bottom:60px}
.steps{padding:0;
list-style:none;
color:var(--muted);
font-size:14px}
.steps li{padding:14px 0;
border-top:1px solid var(--line)}
.status{font:13px/1.6 monospace;
color:var(--accent);
padding:14px 0;
border-top:1px solid var(--line);
border-bottom:1px solid var(--line)}
.notice{padding:18px 22px;
background:var(--panel);
border-left:3px solid var(--accent);
margin-bottom:24px}
.error{border-color:var(--red)}
.repository-list{list-style:none;
padding:0}
.repository-list li{padding:22px 0;
border-top:1px solid var(--line)}
.repository-list a{font-size:20px;
font-weight:600}
.repository-list small{display:block;
color:var(--muted)}
form{margin:20px 0}
fieldset{border:0;
border-top:1px solid var(--line);
padding:22px 0;
margin:0}
legend{font-weight:600;
padding:0 12px 0 0}
label{display:block;
margin:0 0 16px;
font-size:14px}
input:not([type=checkbox]),select,textarea{display:block;
width:100%;
margin-top:5px;
background:var(--bg);
color:var(--fg);
border:1px solid var(--line);
border-radius:3px;
padding:10px;
max-width:650px}
input[type=checkbox]{width:18px;
height:18px;
accent-color:var(--accent);
margin-right:12px;
vertical-align:middle}
input:focus,button:focus-visible,a:focus-visible{outline:3px solid var(--accent);
outline-offset:3px}
.skip{position:absolute;
left:-9999px}
.skip:focus{left:12px;
top:12px;
background:var(--bg);
padding:12px;
z-index:1}
details{border-top:1px solid var(--line);
padding:20px 0}
summary{cursor:pointer;
font-weight:600}
form[aria-busy=true]{opacity:.65}
.connection-actions{display:flex;
gap:20px;
flex-wrap:wrap}
.connection-actions form{margin:6px 0}
code{font-family:monospace;
overflow-wrap:anywhere}
.activity{width:100%;
border-collapse:collapse;
font-size:14px}
.activity td,.activity th{text-align:left;
padding:12px 6px;
border-bottom:1px solid var(--line)}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;
--bg:#16221e;
--fg:#e2e6dc;
--muted:#a2b0a4;
--line:#415147;
--accent:#91c5a1;
--panel:#22332a;
--red:#f1a49b}
:root:not([data-theme=light]) .primary,:root:not([data-theme=light]) button[type=submit]{color:#14231b}
}
:root[data-theme=dark]{color-scheme:dark;
--bg:#16221e;
--fg:#e2e6dc;
--muted:#a2b0a4;
--line:#415147;
--accent:#91c5a1;
--panel:#22332a;
--red:#f1a49b}
:root[data-theme=dark] .primary,:root[data-theme=dark] button[type=submit]{color:#14231b}
@media(max-width:760px){header{padding:22px}
nav{gap:12px}
nav a{font-size:12px}
.brand b{display:none}
main{padding:0 22px}
.hero{padding-top:48px}
.hero-bottom,.principles,.layout{grid-template-columns:1fr;
gap:24px}
.steps{display:flex;
flex-wrap:wrap;
gap:12px}
.steps li{padding:8px 0}
.example-heading{gap:16px}
.example pre{font-size:12px}
.page-title h1{font-size:38px}
footer{gap:20px;
align-items:start}
h2{font-size:30px}
.activity{font-size:12px}
}
`;
