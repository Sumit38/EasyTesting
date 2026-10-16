/* Sign-in, use cases, test-case sets and the guided path. Uses the helpers defined in index.html (el, api, $, toast...). */
(() => {
  'use strict';
  let me = null;
  let accounts = false;
  let ai = { available: false, model: '' };
  let notice = null; // shown once at the top of the next test-case set
  let wantExample = false;
  let S = null; // the test-case set being reviewed: { suite, dirty, open, reads, timers }
  let imp = null; // the upload wizard
  let codeUploads = true;
  let signupOpen = false;

  const parse = async (res) => {
    let body = {};
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new Error(body.error || 'Something went wrong (' + res.status + ').');
    return body;
  };
  const get = (path) => api(path).then(parse);
  const send = (path, body, method = 'POST') => api(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(parse);
  const field = (label, input, hint) => el('label', { class: 'field' }, label, input, hint ? el('span', { class: 'hint', text: hint }) : null);
  const text = (placeholder = '', value = '') => el('input', { type: 'text', placeholder, value, autocomplete: 'off' });
  const pct = (v) => Math.round(v * 100);
  const level = (v) => (v >= 0.85 ? 'good' : v >= 0.6 ? 'mid' : 'low');
  const confPill = (v, label = '') => el('span', { class: 'pill ' + level(v), text: (label ? label + ' ' : '') + pct(v) + '%' });
  const fail = (e) => toast(e.message || String(e));
  const downloadBlob = async (path, name) => {
    const res = await api(path);
    if (!res.ok) return fail(new Error('Could not download that file.'));
    el('a', { href: URL.createObjectURL(await res.blob()), download: name }).click();
  };

  /* ---------- sign in ---------- */
  /** mode: 'setup' (the very first account, an admin), 'signin' or 'signup' (a new tester, when the server allows it). */
  function showAuth(setup, canSignup = false) {
    const box = $('auth');
    box.classList.remove('hidden');
    // The landing page links here: #/signup for new people, #/signin for existing ones.
    let mode = setup ? 'setup' : canSignup && location.hash === '#/signup' ? 'signup' : 'signin';
    const draw = () => {
      const creating = mode === 'setup' || mode === 'signup';
      const email = text('you@company.com');
      email.autocomplete = 'username';
      const name = text('Your name');
      const pw = el('input', { type: 'password', placeholder: 'At least 8 characters', autocomplete: creating ? 'new-password' : 'current-password' });
      const err = el('div', { class: 'err' });
      const go = async () => {
        err.textContent = '';
        try {
          await send(mode === 'setup' ? '/auth/setup' : mode === 'signup' ? '/auth/register' : '/auth/login', { email: email.value, name: name.value, password: pw.value });
          box.classList.add('hidden');
          if (/^#\/sign(in|up)$/.test(location.hash)) location.hash = '#/';
          await start();
        } catch (e) { err.textContent = e.message; }
      };
      pw.onkeydown = (e) => { if (e.key === 'Enter') go(); };
      const tabs = canSignup && mode !== 'setup' ? el('div', { class: 'authtabs' },
        el('button', { class: mode === 'signin' ? 'on' : '', text: 'Sign in', onclick: () => { mode = 'signin'; draw(); } }),
        el('button', { class: mode === 'signup' ? 'on' : '', text: 'Create account', onclick: () => { mode = 'signup'; draw(); } })) : null;
      const intro = { setup: 'Create the first account. This person becomes the admin and can add everyone else.', signup: 'Free to set up. You will be able to write, run and review test cases in a minute.', signin: location.hash === '#/signup' && !canSignup ? 'Accounts here are created by your admin. Sign in with the one you were given.' : 'Welcome back. Sign in to see your test cases and runs.' }[mode];
      box.replaceChildren(el('div', { class: 'box' },
        el('h1', { text: mode === 'setup' ? 'Welcome to EasyTesting' : mode === 'signup' ? 'Create your account' : 'Sign in' }),
        el('p', { text: intro }), tabs,
        field('Email', email), creating ? field('Your name', name) : null, field('Password', pw), err,
        el('button', { class: 'btn primary big', text: creating ? 'Create account' : 'Sign in', onclick: go })));
      email.focus();
    };
    draw();
  }
  Ext.auth = () => { if (accounts && $('auth').classList.contains('hidden')) showAuth(false, signupOpen); };

  function renderUser() {
    const chip = $('userChip');
    chip.replaceChildren();
    $('nav-team').classList.toggle('hidden', !(accounts && me && me.role === 'admin'));
    if (!accounts || !me) return;
    chip.append(el('span', { class: 'chip-user' }, el('b', { text: me.name }), el('span', { text: me.role }),
      el('button', { class: 'btn', text: 'Sign out', onclick: async () => { await api('/auth/logout', { method: 'POST' }); location.hash = '#/'; location.reload(); } })));
  }

  async function start() {
    const st = await fetch('/api/auth/state', { headers: authHeaders }).then((r) => r.json());
    accounts = st.accounts;
    me = st.user;
    codeUploads = st.codeUploads !== false;
    signupOpen = !!st.signup;
    if (accounts && !me) return showAuth(st.setup, signupOpen);
    renderUser();
    if (!codeUploads) {
      // Uploading test code is off on this server: keep the release demo, drop the upload form.
      document.querySelectorAll('#view-new .card').forEach((c) => c.classList.add('hidden'));
      const link = document.querySelector('.nav a[data-nav="code"]');
      if (link) link.textContent = 'Release demo';
    }
    try { ai = await get('/ai'); } catch { /* the AI helper is optional */ }
    route();
  }
  Ext.boot = start;

  /* ---------- routes ---------- */
  Ext.handlers.push(async (h) => {
    try {
      if (h === '') { showView('view-home'); setNav('home'); renderHome(); return true; }
      if (h === 'usecases') { showView('view-usecases'); setNav('usecases'); renderUseCases(); return true; }
      if (h === 'cases') { showView('view-cases'); setNav('cases'); await renderCases(); return true; }
      if (h === 'cases/new') { showView('view-import'); setNav('cases'); renderImport(); return true; }
      if (h === 'team') { showView('view-team'); setNav('team'); await renderTeam(); return true; }
      const m = h.match(/^suite\/(\d+)$/);
      if (m) { showView('view-suite'); setNav('cases'); await renderSuite(m[1]); return true; }
    } catch (e) { fail(e); }
    return false;
  });

  /* ---------- home ---------- */
  const path = (icon, title, body, href, go) =>
    el('a', { class: 'path', href }, el('div', { class: 'ico', text: icon }), el('h3', { text: title }), el('p', { text: body }), el('span', { class: 'go', text: go + ' →' }));

  function renderHome() {
    $('view-home').replaceChildren(
      el('div', { class: 'hero' },
        el('h1', {}, 'Test your web app. ', el('em', { text: 'We write, run and heal the tests.' })),
        el('p', { text: 'Start from whatever you have: a description of what the app should do, test cases in a spreadsheet, or test code. When a button or field changes, the test finds it again instead of failing.' })),
      el('div', { class: 'paths' },
        path('📝', 'I have a use case', 'Describe what the app should do. We write the test cases, and you download them as Excel or CSV.', '#/usecases', 'Generate test cases'),
        path('📋', 'I have test cases', 'Upload your Excel or CSV. We read every step, you confirm what we understood, then we run them and give you a confidence score.', '#/cases/new', 'Upload test cases'),
        ...(codeUploads ? [path('💻', 'I have test code', 'A Playwright or Selenium project as a zip. Nothing in your tests needs to change.', '#/code', 'Upload a project')] : [])),
      el('div', { class: 'demo' },
        el('div', { style: 'flex:1;min-width:240px' }, el('b', { text: 'New here? Watch it work.' }),
          el('p', { text: 'Try the sample use case: we write test cases for a sign-in page, run them in a browser and show the results. Or watch a full release cycle with a real bug and its fix.' })),
        el('button', { class: 'btn primary', text: 'Try the sample use case', onclick: () => { wantExample = true; location.hash = '#/usecases'; } }),
        el('button', { class: 'btn', text: 'Watch the release demo', onclick: () => { location.hash = '#/code'; setTimeout(() => $('demoBtn').click(), 50); } })),
      el('h3', { class: 'sec', text: 'Recent runs' }), el('div', { class: 'runs', id: 'recent' }));
    loadRuns();
  }

  /* ---------- use cases ---------- */
  function renderUseCases() {
    const box = $('view-usecases');
    const title = text('Optional: a name for these test cases');
    const body = el('textarea', { rows: 14, placeholder: 'Paste your use case here, for example:\n\nUse Case: User login\nActor: Registered customer\nMain Flow:\n1. The user opens the login page\n2. The user enters email and password\n3. The user clicks the Sign in button\n4. The system shows the dashboard\nAlternate Flows:\nA1. Wrong password: the system shows "Invalid credentials"\nBusiness Rules:\n- The password must be at least 8 characters' });
    const start_ = text('Optional: /login (the page to open first)');
    const app = text('Optional: https://staging.yourapp.com (used when you run them)');
    const data = el('textarea', { rows: 3, placeholder: 'Optional, one per line:\nemail=sam@example.com\npassword=Secret123!' });
    let method = 'auto';
    const radios = el('div', { class: 'radios' });
    const paint = () => {
      radios.replaceChildren(...[
        ['auto', 'Automatic (recommended)', ai.available ? 'Reads your use case, whatever its layout, and checks how well it understood it. If the reading is poor, Claude reads it instead. The text leaves this server only then.' : 'Reads your use case, whatever its layout, checks how well it understood it, and tells you what to change if something is unclear.', true],
        ['rules', 'Standard only (works offline)', 'Reads your headings and steps and writes positive, negative, boundary and alternate-flow cases. Nothing leaves this server.', true],
        ['ai', 'Improve with AI (Claude)', ai.available ? 'Writes broader cases from the same text. The use case is sent to Anthropic. If it fails, the standard method is used instead.' : 'Not set up on this server. An admin can enable it by setting ANTHROPIC_API_KEY.', ai.available],
      ].map(([v, t, d, enabled]) => el('label', { class: 'radio' + (method === v ? ' on' : '') + (enabled ? '' : ' off') },
        el('input', { type: 'radio', name: 'method', value: v, checked: method === v, disabled: !enabled, onchange: () => { method = v; paint(); } }), el('div', {}, el('b', { text: t }), el('span', { text: d })))));
    };
    paint();
    const file = el('input', { type: 'file', accept: '.txt,.md,.csv,.xlsx', class: 'hidden', onchange: async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        const out = await api('/usecases/read?filename=' + encodeURIComponent(f.name), { method: 'POST', body: f }).then(parse);
        body.value = out.text;
        if (!title.value) title.value = f.name.replace(/\.[^.]+$/, '');
      } catch (e) { fail(e); }
    } });
    const err = el('div', { class: 'err' });
    const go = el('button', { class: 'btn primary big', text: '✨ Generate test cases' });
    go.onclick = async () => {
      err.textContent = '';
      go.disabled = true;
      go.textContent = method === 'ai' ? 'Asking Claude…' : 'Reading your use case…';
      try {
        const out = await send('/usecases/generate', { title: title.value, text: body.value, method, startPage: start_.value, testData: data.value, appUrl: app.value });
        notice = { notes: out.notes, by: out.by, fallbackReason: out.fallbackReason, switched: out.switched, analysis: out.analysis, fresh: true };
        location.hash = '#/suite/' + out.suite.id;
      } catch (e) { err.textContent = e.message; }
      go.disabled = false;
      go.textContent = '✨ Generate test cases';
    };
    box.replaceChildren(
      el('div', { class: 'hero' }, el('h1', {}, 'Describe the use case. ', el('em', { text: 'Get test cases.' })),
        el('p', { text: 'Paste it or upload a text, Markdown, CSV or Excel file. You review the generated cases, download them, and run them when you are ready.' })),
      el('section', { class: 'card' },
        el('h2', {}, el('span', { class: 'n', text: '1' }), 'Your use case'),
        el('p', { class: 'sub', text: 'Headings such as Main Flow, Alternate Flows, Business Rules and Given/When/Then are recognised. Plain sentences work too.' }),
        el('div', { class: 'body' }, body, el('div', { class: 'row', style: 'margin-top:10px' },
          el('button', { class: 'btn', text: '📎 Upload a file', onclick: () => file.click() }), file,
          el('button', { class: 'btn', text: 'Use the sample', onclick: async () => { const ex = await get('/example'); body.value = ex.useCase; data.value = Object.entries(ex.testData).map(([k, v]) => k + '=' + v).join('\n'); app.value = location.origin + '/demo/login?v=1'; title.value = 'Sign in to Acme (sample)'; } }),
          el('span', { class: 'hint', text: 'Word and PDF files: copy the text and paste it above.' })))),
      el('section', { class: 'card' },
        el('h2', {}, el('span', { class: 'n', text: '2' }), 'Details (all optional)'),
        el('div', { class: 'body' }, el('div', { class: 'adv' }, field('Name', title), field('First page to open', start_), field('App link', app)),
          el('div', { style: 'margin-top:12px' }, field('Test data to use', data, 'Without it, sample values are used and flagged for you to replace.')))),
      el('section', { class: 'card' },
        el('h2', {}, el('span', { class: 'n', text: '3' }), 'How should we write them?'), el('div', { class: 'body' }, radios,
          el('div', { class: 'cta' }, go, err))));
    if (wantExample) {
      wantExample = false;
      get('/example').then((ex) => { body.value = ex.useCase; data.value = Object.entries(ex.testData).map(([k, v]) => k + '=' + v).join('\n'); app.value = location.origin + '/demo/login?v=1'; title.value = 'Sign in to Acme (sample)'; });
    }
  }

  /* ---------- the list of test-case sets ---------- */
  async function renderCases() {
    const list = await get('/suites');
    const box = $('view-cases');
    box.replaceChildren(
      el('div', { class: 'hero' }, el('h1', { text: 'Test cases' }), el('p', { text: 'Every set you generated or uploaded. Open one to review how each step was understood, edit it, download it, or run it.' })),
      el('div', { class: 'row', style: 'margin-top:16px' },
        el('a', { class: 'btn primary', href: '#/cases/new', text: '📋 Upload test cases' }), el('a', { class: 'btn', href: '#/usecases', text: '📝 Generate from a use case' })),
      el('div', { class: 'runs', style: 'margin-top:16px' }, ...(list.length ? list.map((x) =>
        el('div', { class: 'run', onclick: () => { location.hash = '#/suite/' + x.id; } },
          el('div', { class: 'nm', text: x.title }), el('div', { class: 'mt', text: `${x.cases} test case${x.cases === 1 ? '' : 's'} · ${x.source === 'generated' ? 'generated from a use case' : 'uploaded'} · ${when(x.updatedAt)}` }),
          el('div', { class: 'stats' }, el('span', { class: 'badge b-' + (x.source === 'generated' ? 'info' : 'ok'), text: x.source }),
            el('button', { class: 'btn', text: 'Delete', onclick: async (e) => { e.stopPropagation(); if (confirm('Delete "' + x.title + '"?')) { await api('/suites/' + x.id, { method: 'DELETE' }); renderCases(); } } })))) : [el('div', { class: 'empty', text: 'Nothing here yet. Generate test cases from a use case, or upload a spreadsheet.' })])));
  }

  /* ---------- upload wizard ---------- */
  const FIELD_LABEL = { id: 'ID', title: 'Title', area: 'Area / module', priority: 'Priority', type: 'Type', preconditions: 'Preconditions', steps: 'Steps (required)', expected: 'Expected result', basis: 'Basis (stated / assumed)' };
  const FIELD_HELP = {
    id: 'The test case number, for example TC-01. If your file has none, choose (none) and we number the cases for you.',
    title: 'The short name of the test case, for example "Log in with a wrong password". Shown in the results and reports.',
    area: 'Which part of the app the case tests, for example Login or Checkout. Optional: it groups the results.',
    priority: 'High, Medium or Low. Optional: a failure in a High case becomes a high-severity bug in the report.',
    type: 'Positive, Negative, Boundary and so on. Optional: shown as a label on each case.',
    preconditions: 'What must be true before step 1, for example "The user is logged out". Optional: shown with the case, not run.',
    steps: 'Required. The column with what to do, for example "Click the Login button". One step per line in the cell, or one step per row. These are the steps we run.',
    expected: 'What should happen at the end, for example "The dashboard opens". Optional, but it makes the report easier to read.',
    basis: 'Only for files this tool wrote: whether the expected result came from the use case (Stated) or was a guess (Assumed). For your own files, leave it on (none).',
  };
  function renderImport() { imp = { step: 1 }; drawImport(); }
  function drawImport() {
    const box = $('view-import');
    const stepper = el('div', { class: 'stepper' }, ...['1 Upload', '2 Match the columns', '3 Review and run'].map((t, i) => el('span', { class: i + 1 === imp.step ? 'on' : i + 1 < imp.step ? 'done' : '', text: t })));
    const head = el('div', { class: 'hero' }, el('h1', {}, 'Upload your test cases. ', el('em', { text: 'We follow you through it.' })), el('p', { text: 'Excel or CSV. Any column names: you tell us which column is which.' }));
    if (imp.step === 1) {
      const file = el('input', { type: 'file', accept: '.xlsx,.csv,.txt', class: 'hidden' });
      const drop = el('div', { class: 'drop', tabindex: 0, role: 'button' }, el('div', { class: 'big', text: '📋' }), el('div', {}, el('b', { text: 'Drop your Excel or CSV file here' })), el('div', { text: 'or click to choose a file' }));
      const take = async (f) => {
        if (!f) return;
        drop.classList.add('has');
        try {
          const out = await api('/imports?filename=' + encodeURIComponent(f.name), { method: 'POST', body: f }).then(parse);
          imp = { ...out, step: 2, hasHeader: out.hasHeader, title: f.name.replace(/\.[^.]+$/, ''), app: '' };
          drawImport();
        } catch (e) { drop.classList.remove('has'); fail(e); }
      };
      drop.onclick = () => file.click();
      file.onchange = () => take(file.files[0]);
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); take(e.dataTransfer.files[0]); };
      box.replaceChildren(head, stepper, el('section', { class: 'card' }, drop, file,
        el('p', { class: 'hint', style: 'margin-top:12px', text: 'Steps can be in one cell (one per line, numbered or not) or one per row. Old .xls files: save them as .xlsx or CSV first.' }),
        el('div', { class: 'cta' }, el('a', { class: 'btn', href: '#/usecases', text: 'I only have a use case' }))));
      return;
    }
    // step 2: match columns
    const selects = {};
    const first = imp.preview[0] || [];
    const confirmBtn = el('button', { class: 'btn primary big', text: 'Continue: read my steps' });
    const stepsWarn = el('div', { class: 'err' });
    const checkSteps = () => {
      const missing = Number(selects.steps.value) < 0;
      selects.steps.closest('.mapfield').classList.toggle('missing', missing);
      stepsWarn.textContent = missing ? 'Choose the column that holds the steps. It is the only one we need, because the steps are what we run.' : '';
      confirmBtn.disabled = missing;
    };
    const mapGrid = el('div', { class: 'mapgrid' }, ...imp.fields.map((f) => {
      const sel = el('select', {}, el('option', { value: -1, text: '(none)' }), ...imp.header.map((h, i) => el('option', { value: i, text: `${String.fromCharCode(65 + (i % 26))}: ${h || '(blank)'}`, selected: imp.mapping[f] === i })));
      sel.setAttribute('aria-label', FIELD_LABEL[f]);
      selects[f] = sel;
      const sample = el('div', { class: 'mapsample' });
      const showSample = () => {
        const i = Number(sel.value);
        const v = i >= 0 ? String(first[i] || '').replace(/\s+/g, ' ').trim() : '';
        sample.textContent = i < 0 ? (f === 'steps' ? '' : 'Not used.') : v ? 'Row 1: ' + v : 'Row 1: (empty)';
        sample.title = v;
      };
      sel.onchange = () => { showSample(); if (f === 'steps') checkSteps(); };
      showSample();
      const tip = el('div', { class: 'tipbox hidden', text: FIELD_HELP[f] });
      const info = el('button', { type: 'button', class: 'info', text: 'i', title: FIELD_HELP[f] });
      info.setAttribute('aria-label', 'What goes in ' + FIELD_LABEL[f] + '?');
      info.setAttribute('aria-expanded', 'false');
      info.onclick = () => { const open = tip.classList.toggle('hidden') === false; info.setAttribute('aria-expanded', String(open)); };
      return el('div', { class: 'mapfield' + (f === 'steps' ? ' req' : '') }, el('div', { class: 'maplabel' }, el('span', { text: FIELD_LABEL[f] }), info), sel, sample, tip);
    }));
    const guide = el('div', { class: 'guide' },
      el('b', { text: 'How to match the columns' }),
      el('ol', {},
        el('li', { text: 'Each box below is one part of a test case. Its list shows the columns of your file (A, B, C… with their headings).' }),
        el('li', { text: 'For each box, pick the column that holds that part. We already guessed from your headings; check the "Row 1" preview under each box.' }),
        el('li', { text: 'Only Steps is required. If your file has no column for something, leave it on "(none)".' }),
        el('li', {}, 'Not sure what a box means? Click its ', el('b', { text: 'i' }), ' button.')));
    const title = text('', imp.title);
    const app = text('https://staging.yourapp.com', imp.app || '');
    const err = el('div', { class: 'err' });
    confirmBtn.onclick = async () => {
      err.textContent = '';
      confirmBtn.disabled = true;
      try {
        const mapping = Object.fromEntries(imp.fields.map((f) => [f, Number(selects[f].value)]));
        const out = await send(`/imports/${imp.importId}/confirm`, { mapping, hasHeader: imp.hasHeader, title: title.value, appUrl: app.value });
        notice = { warnings: out.warnings, fresh: true };
        location.hash = '#/suite/' + out.suite.id;
      } catch (e) { err.textContent = e.message; }
      confirmBtn.disabled = false;
    };
    box.replaceChildren(head, stepper,
      el('section', { class: 'card' },
        el('h2', { text: `We found ${imp.rowCount} row${imp.rowCount === 1 ? '' : 's'} in ${imp.filename}` }),
        el('p', { class: 'sub', style: 'margin-left:0', text: imp.hasHeader ? 'The first row looks like headings. We guessed which column is which. Fix anything that is wrong.' : 'There is no heading row, so choose the columns below.' }),
        el('div', { class: 'tblwrap' }, el('table', { class: 'tbl' }, el('thead', {}, el('tr', {}, ...imp.header.map((h) => el('th', { text: h })))),
          el('tbody', {}, ...imp.preview.map((r) => el('tr', {}, ...imp.header.map((_, i) => el('td', { text: (r[i] || '').slice(0, 120) }))))))),
        guide,
        mapGrid,
        stepsWarn,
        el('div', { class: 'adv' }, field('Name this set', title), field('App link (optional now, needed to run)', app, 'The website to test, starting with https://. You can also add it on the next screen.')),
        el('div', { class: 'cta' }, confirmBtn, el('button', { class: 'btn', text: 'Start over', onclick: renderImport }), err)));
    checkSteps();
  }

  /* ---------- review, edit, download and run one set ---------- */
  const strip = (suite) => suite.cases.map((c) => ({ id: c.id, title: c.title, area: c.area, priority: c.priority, type: c.type, preconditions: c.preconditions, steps: c.steps, expected: c.expected, source: c.source }));

  async function renderSuite(id) {
    const suite = await get('/suites/' + id);
    S = { suite, dirty: false, open: new Set(suite.cases.filter((c) => c.interpreted.some((s) => s.confidence < 0.6)).map((c) => c.id)), reads: {}, timers: {}, tickets: {}, badges: {} };
    if (S.open.size === 0 && suite.cases[0]) S.open.add(suite.cases[0].id);
    drawSuite();
  }

  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const tileEl = (v, k, sub, cls = '') => el('div', { class: 'tile ' + cls }, el('div', { class: 'v', text: v }), el('div', { class: 'k', text: k }), sub ? el('div', { class: 's', text: sub }) : null);

  function paintRead(box, st, caseId, index) {
    box.replaceChildren();
    if (!st.text.trim()) { box.append(el('span', { text: 'Write what should happen in this step.' })); return; }
    box.append(el('span', { class: 'tag', text: st.action === 'unknown' ? 'not understood' : st.action }), el('span', { text: st.action === 'unknown' ? (st.notes[0] || '') : st.summary }), confPill(st.confidence));
    if (st.action !== 'unknown') for (const n of st.notes.slice(0, 1)) box.append(el('span', { text: '· ' + n }));
    if (st.confidence < 0.6 && ai.available) {
      box.append(el('button', { class: 'mini', text: '✨ Suggest a rewrite', onclick: async (e) => {
        e.target.disabled = true;
        try {
          const out = await send('/steps/improve', { steps: [st.text] });
          const better = out.steps[0];
          const row = box.parentElement;
          const old = row.querySelector('.sugg');
          if (old) old.remove();
          row.append(el('div', { class: 'sugg' }, el('span', {}, 'Suggestion: ', el('b', { text: better.text })), confPill(better.confidence),
            el('button', { class: 'mini', text: 'Use it', onclick: () => { applyStep(caseId, index, better.text); } }), el('button', { class: 'mini', text: 'Keep mine', onclick: (ev) => ev.target.closest('.sugg').remove() })));
        } catch (err) { fail(err); }
        e.target.disabled = false;
      } }));
    }
  }

  function applyStep(caseId, index, textValue) {
    const c = S.suite.cases.find((x) => x.id === caseId);
    c.steps[index] = textValue;
    markDirty();
    drawSuite();
  }

  function reinterpret(c) {
    clearTimeout(S.timers[c.id]);
    S.timers[c.id] = setTimeout(async () => {
      // Only the newest answer counts: a slow reply to an older keystroke must not overwrite a newer one.
      const ticket = (S.tickets[c.id] = (S.tickets[c.id] || 0) + 1);
      const sent = c.steps.slice();
      try {
        const out = await send('/steps/interpret', { steps: sent });
        if (ticket !== S.tickets[c.id] || S.suite.cases.indexOf(c) === -1) return;
        c.interpreted = out.steps;
        repaintCase(c);
      } catch { /* try again on the next keystroke */ }
    }, 300);
  }

  /** Updates everything that shows how a case's steps were read: each step, its row colour, the case's badge and the totals. */
  function repaintCase(c) {
    (S.reads[c.id] || []).forEach((box, i) => {
      const it = c.interpreted[i];
      if (!box || !it) return;
      paintRead(box, it, c.id, i);
      const row = box.parentElement;
      const filled = (c.steps[i] || '').trim();
      if (row) row.className = 'stepline' + (filled && it.confidence < 0.6 ? ' weak' : '') + (filled && it.action === 'unknown' ? ' bad' : '');
    });
    paintCaseBadge(c);
    paintSummary();
  }

  const filledSteps = (c) => c.interpreted.filter((s, i) => (c.steps[i] || '').trim());
  function paintCaseBadge(c) {
    const slot = S.badges[c.id];
    if (!slot) return;
    const steps = filledSteps(c);
    const weak = steps.filter((s) => s.confidence < 0.6).length;
    slot.replaceChildren(!steps.length ? el('span', { class: 'pill low', text: 'no steps' }) : weak ? el('span', { class: 'pill mid', text: weak + ' to check' }) : confPill(mean(steps.map((s) => s.confidence))));
  }

  function markDirty() {
    S.dirty = true;
    const bar = $('savebar');
    if (bar) bar.classList.remove('hidden');
  }

  async function saveSuite() {
    const out = await send('/suites/' + S.suite.id, { title: S.suite.title, appUrl: $('suiteApp') ? $('suiteApp').value.trim() : S.suite.appUrl, cases: strip(S.suite) }, 'PUT');
    S.suite = out;
    S.dirty = false;
    drawSuite();
    toast('Saved.');
  }

  function paintSummary() {
    const box = $('suiteTiles');
    if (!box) return;
    // Blank steps (a line just added, not yet written) are not counted: they would pull the score down to 0 for no reason.
    const steps = S.suite.cases.flatMap(filledSteps);
    const weak = steps.filter((s) => s.confidence < 0.6).length;
    box.replaceChildren(
      tileEl(String(S.suite.cases.length), 'Test cases', `${steps.length} steps`),
      tileEl(pct(mean(steps.map((s) => s.confidence))) + '%', 'Understood', 'how sure we are we read the steps right', weak ? 'warn' : 'good'),
      tileEl(String(weak), weak === 1 ? 'Step needs you' : 'Steps need you', weak ? 'rewrite them below before running' : 'nothing unclear', weak ? 'warn' : 'good'));
  }

  function caseCard(c) {
    const reads = [];
    S.reads[c.id] = reads;
    const stepsBox = el('div');
    const drawSteps = () => {
      reads.length = 0;
      stepsBox.replaceChildren(...c.steps.map((st, i) => {
        const input = el('input', { type: 'text', value: st, placeholder: 'e.g. Click the "Sign in" button' });
        const read = el('div', { class: 'read' });
        reads[i] = read;
        const it = c.interpreted[i] || { text: st, action: 'unknown', confidence: 0, notes: [], summary: '' };
        paintRead(read, it, c.id, i);
        const row = el('div', { class: 'stepline' + (it.confidence < 0.6 && st.trim() ? ' weak' : '') + (it.action === 'unknown' && st.trim() ? ' bad' : '') },
          el('div', { class: 'n', text: String(i + 1) }), input,
          el('button', { class: 'mini', text: '✕', title: 'Remove this step', onclick: () => { c.steps.splice(i, 1); c.interpreted.splice(i, 1); markDirty(); drawSteps(); repaintCase(c); reinterpret(c); } }), read);
        input.oninput = () => {
          c.steps[i] = input.value;
          markDirty();
          read.replaceChildren(el('span', { text: input.value.trim() ? 'Reading…' : 'Write what should happen in this step.' }));
          reinterpret(c);
        };
        return row;
      }));
    };
    drawSteps();
    const d = el('details', { class: 'case' });
    d.open = S.open.has(c.id);
    d.ontoggle = () => (d.open ? S.open.add(c.id) : S.open.delete(c.id));
    const title = el('input', { type: 'text', value: c.title });
    title.oninput = () => { c.title = title.value; markDirty(); };
    const expected = el('textarea', { rows: 2, placeholder: 'What should happen overall?' });
    expected.value = c.expected || '';
    expected.oninput = () => { c.expected = expected.value; markDirty(); };
    const pre = el('textarea', { rows: 1, placeholder: 'Anything that must be true before step 1' });
    pre.value = c.preconditions || '';
    pre.oninput = () => { c.preconditions = pre.value; markDirty(); };
    d.append(
      el('summary', {}, el('b', { text: c.id }), el('span', { text: c.title }), c.type ? el('span', { class: 'pill', text: c.type }) : null, c.priority ? el('span', { class: 'pill', text: c.priority }) : null, c.basis === 'assumed' ? el('span', { class: 'pill mid', title: 'The use case does not say what should happen here, so the expected result is a guess.', text: 'assumed' }) : null,
        el('span', { class: 'spacer' }), (S.badges[c.id] = el('span'))),
      el('div', { class: 'body2' }, field('Title', title), c.preconditions !== undefined || true ? field('Before you start', pre) : null, el('div', {}, el('b', { text: 'Steps' }), stepsBox),
        el('div', { class: 'row' }, el('button', { class: 'btn', text: '+ Add a step', onclick: () => {
          c.steps.push(''); c.interpreted.push({ text: '', action: 'unknown', confidence: 0, notes: [], summary: '' }); markDirty(); drawSteps(); repaintCase(c);
          const inputs = stepsBox.querySelectorAll('input'); if (inputs.length) inputs[inputs.length - 1].focus();
        } }),
          el('span', { class: 'spacer' }), el('button', { class: 'btn danger', text: 'Delete this test case', onclick: () => { if (confirm('Delete ' + c.id + '?')) { S.suite.cases = S.suite.cases.filter((x) => x !== c); markDirty(); drawSuite(); } } })),
        field('Expected result', expected)));
    paintCaseBadge(c);
    return d;
  }

  /* ---------- fix the gaps: every unclear step once, fixed for all the cases that use it ---------- */
  const PLACEHOLDER = /<([a-z][a-z0-9 '-]{0,58})>/i;
  /** The unclear steps of the set, each text once, most used first. */
  function gapGroups() {
    const groups = new Map();
    for (const c of S.suite.cases) {
      c.steps.forEach((st, i) => {
        const it = c.interpreted[i];
        const t = (st || '').trim();
        if (!t || !it || it.confidence >= 0.6) return;
        const g = groups.get(t) || { text: t, it, cases: new Set(), count: 0 };
        g.cases.add(c.id);
        g.count++;
        groups.set(t, g);
      });
    }
    return [...groups.values()].sort((a, b) => b.cases.size - a.cases.size || b.count - a.count);
  }

  /** Changes one step text in every case (or removes it when `to` is null), then saves, which reads every step again. */
  async function replaceEverywhere(from, to) {
    for (const c of S.suite.cases) {
      for (let i = c.steps.length - 1; i >= 0; i--) {
        if ((c.steps[i] || '').trim() !== from) continue;
        if (to === null) { c.steps.splice(i, 1); c.interpreted.splice(i, 1); } else c.steps[i] = to;
      }
    }
    await saveSuite();
  }

  function gapRow(g) {
    const ph = g.text.match(PLACEHOLDER);
    const where = `in ${g.cases.size} test case${g.cases.size === 1 ? '' : 's'}`;
    const err = el('div', { class: 'err' });
    const act = async (fn) => { err.textContent = ''; try { await fn(); } catch (e) { err.textContent = e.message; } };
    const del = el('button', { class: 'btn', text: 'Delete everywhere', title: 'Remove this step from every test case that has it', onclick: () => act(() => replaceEverywhere(g.text, null)) });
    let body;
    if (ph) {
      // "Click "<product>"": ask only for the missing name.
      const input = text('e.g. ' + (/search/i.test(g.text) ? 'laptop' : /payment/i.test(ph[1]) ? 'Credit card' : 'Wireless Mouse'));
      const go = el('button', { class: 'btn primary', text: `Use it ${where}`, onclick: () => act(async () => {
        if (!input.value.trim()) throw new Error('Type the ' + ph[1] + ' first.');
        await replaceEverywhere(g.text, g.text.replace(PLACEHOLDER, input.value.trim().replace(/"/g, "'")));
      }) });
      input.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
      const question = /^search/i.test(g.text) ? 'What should be searched for?' : `Which ${ph[1]}? Type it exactly as it appears on the page.`;
      body = [el('label', { class: 'gapq', text: question }), el('div', { class: 'gapfix' }, input, go, del)];
    } else if (g.it.needsValue) {
      // "Enter valid password": ask only for the text to type.
      const field = g.it.target || 'field';
      const input = el('input', { type: /password|pin|otp/i.test(field) ? 'password' : 'text', placeholder: `Text for the ${field} field`, autocomplete: 'off' });
      const go = el('button', { class: 'btn primary', text: `Use it ${where}`, onclick: () => act(async () => {
        if (!input.value) throw new Error('Type the text first.');
        await replaceEverywhere(g.text, `Enter "${input.value.replace(/"/g, "'")}" in the ${field} field`);
      }) });
      input.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
      body = [el('label', { class: 'gapq', text: `What should be typed in the ${field} field? Use a real test account's details if the app needs one.` }), el('div', { class: 'gapfix' }, input, go, del)];
    } else {
      // Anything else: rewrite it once, see how it will be read, apply it to every case.
      const input = text('', g.text);
      const preview = el('div', { class: 'gapread' });
      const showRead = (it) => preview.replaceChildren(el('span', { class: 'tag', text: it.action === 'unknown' ? 'not understood' : it.action }), el('span', { text: it.action === 'unknown' ? 'Not an action we can run. Rewrite it, or delete it if it is a heading or a note.' : it.summary + (it.notes[0] ? ' · ' + it.notes[0] : '') }), confPill(it.confidence));
      showRead(g.it);
      let t;
      input.oninput = () => { clearTimeout(t); t = setTimeout(async () => { try { showRead((await send('/steps/interpret', { steps: [input.value] })).steps[0]); } catch { /* next keystroke */ } }, 300); };
      const go = el('button', { class: 'btn primary', text: `Apply ${where}`, onclick: () => act(async () => {
        if (!input.value.trim() || input.value.trim() === g.text) throw new Error('Rewrite the step first, or delete it.');
        await replaceEverywhere(g.text, input.value.trim());
      }) });
      const sugg = ai.available ? el('button', { class: 'btn', text: '✨ Suggest', onclick: () => act(async () => {
        const better = (await send('/steps/improve', { steps: [input.value] })).steps[0];
        input.value = better.text; showRead(better);
      }) }) : null;
      body = [el('div', { class: 'gapfix' }, input, go, sugg, del), preview];
    }
    return el('div', { class: 'gap' }, el('div', { class: 'gaphead' }, el('b', { text: g.text }), el('span', { class: 'pill mid', text: where })), ...body, err);
  }

  function gapsPanel() {
    const groups = gapGroups();
    if (!groups.length) return null;
    const total = groups.reduce((n, g) => n + g.count, 0);
    const junk = groups.filter((g) => g.it.action === 'unknown' && !PLACEHOLDER.test(g.text));
    const junkCount = junk.reduce((n, g) => n + g.count, 0);
    const shown = S.allGaps ? groups : groups.slice(0, 8);
    const tools = el('div', { class: 'row' },
      junkCount ? el('button', { class: 'btn danger', text: `Remove the ${junkCount} step${junkCount === 1 ? '' : 's'} we could not understand at all`, onclick: async () => {
        if (!confirm(`Remove ${junkCount} unreadable step${junkCount === 1 ? '' : 's'} (${junk.length} different text${junk.length === 1 ? '' : 's'}) from every test case? Steps that only need a value are kept.`)) return;
        const drop = new Set(junk.map((g) => g.text));
        for (const c of S.suite.cases) for (let i = c.steps.length - 1; i >= 0; i--) if (drop.has((c.steps[i] || '').trim())) { c.steps.splice(i, 1); c.interpreted.splice(i, 1); }
        try { await saveSuite(); } catch (e) { fail(e); }
      } }) : null,
      S.suite.usecaseId ? el('button', { class: 'btn', text: '↻ Rebuild from the use case', title: 'Write the test cases again from the same use case with the latest generator', onclick: async (e) => {
        if (!confirm('Write these test cases again from the use case? Changes you made here are replaced.')) return;
        e.target.disabled = true;
        try {
          const out = await send(`/suites/${S.suite.id}/regenerate`, { method: 'auto' });
          notice = { notes: out.notes, by: out.by, fallbackReason: out.fallbackReason, switched: out.switched, analysis: out.analysis, fresh: true };
          S.suite = out.suite; S.dirty = false; S.open = new Set(); drawSuite(); toast('Rebuilt from the use case.');
        } catch (err) { fail(err); }
        e.target.disabled = false;
      } }) : null);
    return el('section', { class: 'gaps', id: 'gaps' },
      el('div', { class: 'gapstitle' }, el('h3', { text: `Fix the gaps: ${total} step${total === 1 ? '' : 's'} need you` }),
        el('span', { class: 'hint', text: `${groups.length} different step${groups.length === 1 ? '' : 's'}. Fix each one once here and it is fixed in every test case that has it.` }),
        el('div', { class: 'hint', text: 'Steps that are always understood look like: Click the "Pay" button · Enter "jane@example.com" in the Email field · Select "UK" from the Country dropdown · Verify "Order placed" is displayed.' })),
      tools,
      ...shown.map(gapRow),
      groups.length > shown.length ? el('button', { class: 'btn', text: `Show all ${groups.length}`, onclick: () => { S.allGaps = true; drawSuite(); } }) : null);
  }

  function drawSuite() {
    const box = $('view-suite');
    const s = S.suite;
    const title = el('input', { type: 'text', class: 'title', value: s.title });
    title.oninput = () => { s.title = title.value; markDirty(); };
    const app = text('https://staging.yourapp.com', s.appUrl || '');
    app.id = 'suiteApp';
    app.oninput = () => markDirty();
    const run = el('button', { class: 'btn primary big', text: '▶ Run these test cases' });
    // Remembered per browser: someone who wants to stop at the first failure usually wants it every time.
    const stopFirst = el('input', { type: 'checkbox' });
    try { stopFirst.checked = localStorage.getItem('et-stop-first') === '1'; } catch { /* storage blocked */ }
    stopFirst.onchange = () => { try { localStorage.setItem('et-stop-first', stopFirst.checked ? '1' : '0'); } catch { /* storage blocked */ } };
    run.onclick = async () => {
      const link = app.value.trim();
      if (!/^https?:\/\/\S+$/i.test(link)) return toast('Enter the app link first, starting with http:// or https://');
      run.disabled = true;
      try {
        if (S.dirty) await saveSuite();
        else if (link !== s.appUrl) await send('/suites/' + s.id, { appUrl: link }, 'PUT');
        const r = await send(`/suites/${s.id}/run`, { appUrl: link, stopOnFail: stopFirst.checked });
        location.hash = '#/run/' + r.id;
      } catch (e) { fail(e); }
      run.disabled = false;
    };
    const notes = [];
    if (notice && notice.fresh) {
      const a = notice.analysis;
      if (a) {
        // What the tool made of the use case, before anyone runs anything.
        const word = { good: ['Understood well', 'good'], fair: ['Mostly understood', 'mid'], poor: ['Poorly understood', 'low'] }[a.quality];
        notes.push(el('section', { class: 'analysis' },
          el('div', { class: 'gaphead' }, el('h3', { text: 'What we found in your use case' }), el('span', { class: 'pill ' + word[1], text: word[0] })),
          el('p', { text: a.summary }),
          el('div', { class: 'counts' },
            el('span', {}, el('b', { text: String(a.found.flowSteps) }), a.found.flowSteps === 1 ? ' flow step' : ' flow steps'),
            el('span', {}, el('b', { text: String(a.found.alternates) }), a.found.alternates === 1 ? ' alternate flow' : ' alternate flows'),
            el('span', {}, el('b', { text: String(a.found.rules) }), a.found.rules === 1 ? ' business rule' : ' business rules'),
            el('span', {}, el('b', { text: String(a.found.preconditions) }), a.found.preconditions === 1 ? ' precondition' : ' preconditions'),
            a.found.scenarios ? el('span', {}, el('b', { text: String(a.found.scenarios) }), ' Given/When/Then scenarios') : null,
            a.actor ? el('span', {}, 'Actor: ', el('b', { text: a.actor })) : null),
          a.advice.length ? el('ul', {}, ...a.advice.map((t) => el('li', { text: t }))) : null));
      }
      if (notice.switched) notes.push(el('div', { class: 'note good' }, el('b', { text: 'Read by Claude. ' }), notice.switched));
      if (notice.fallbackReason) notes.push(el('div', { class: 'note' }, el('b', { text: 'AI was not used. ' }), notice.fallbackReason + ' The standard method wrote these cases instead.'));
      else if (notice.by === 'ai' && !notice.switched) notes.push(el('div', { class: 'note good', text: 'Written with Claude. Every step was checked against the step reader; review them before you run.' }));
      for (const n of (notice.notes || []).slice(0, 8)) notes.push(el('div', { class: 'note', text: n }));
      for (const w of notice.warnings || []) notes.push(el('div', { class: 'note', text: w }));
      notice = null;
    }
    box.replaceChildren(
      el('p', { class: 'crumb' }, el('a', { href: '#/cases', text: '← All test cases' })),
      el('div', { class: 'suite-head' }, title, el('span', { class: 'badge b-' + (s.source === 'generated' ? 'info' : 'ok'), text: s.source }),
        el('button', { class: 'btn', text: '⬇ Excel', onclick: () => downloadBlob(`/suites/${s.id}/download?format=xlsx`, s.title.replace(/[^\w.-]+/g, '_') + '.xlsx') }),
        el('button', { class: 'btn', text: '⬇ CSV', onclick: () => downloadBlob(`/suites/${s.id}/download?format=csv`, s.title.replace(/[^\w.-]+/g, '_') + '.csv') })),
      ...notes,
      el('div', { class: 'tiles', id: 'suiteTiles' }),
      gapsPanel(),
      el('div', { class: 'runbox' }, field('App link to test', app, 'Where the app lives. The test cases run in a real browser against it.'),
        el('div', { class: 'runside' }, run, el('label', { class: 'check', title: 'When one test case fails, the rest are not run. Useful when a broken page would make every later case fail too.' }, stopFirst, ' Stop at the first failed test case'))),
      el('h3', { class: 'sec', text: 'Check how each step was read' }),
      el('p', { class: 'hint', style: 'margin:-6px 0 12px', text: 'Every step is shown with what we understood and how sure we are. Anything under 60% needs a rewrite, because we will not guess what you meant.' }),
      ...s.cases.map(caseCard),
      el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn', text: '+ Add a test case', onclick: () => {
        const n = s.cases.length + 1;
        s.cases.push({ id: 'TC-' + String(n).padStart(3, '0') + '-new', title: 'New test case', steps: ['Open the application'], expected: '', interpreted: [{ text: 'Open the application', action: 'open', confidence: 0.93, notes: [], summary: 'Open the app' }] });
        markDirty(); S.open.add(s.cases[s.cases.length - 1].id); drawSuite();
      } })),
      el('div', { class: 'savebar' + (S.dirty ? '' : ' hidden'), id: 'savebar' }, el('span', { text: 'You have unsaved changes.' }), el('span', { class: 'spacer' }),
        el('button', { class: 'btn primary', text: 'Save changes', onclick: () => saveSuite().catch(fail) })));
    paintSummary();
  }

  /* ---------- results of a test-case run, live while it runs ---------- */
  let stepsSig = '';
  let shownRun = '';
  // Plain words for each state, for people who have never seen a test log.
  const CASE_WORD = { passed: ['Passed', 'ok'], failed: ['Failed', 'bad'], blocked: ['Blocked', 'warn'], skipped: ['Not run', 'mute'], running: ['Running now', 'info live'], pending: ['Waiting', 'mute'] };
  const STEP_WORD = { passed: ['✔', 'Done'], failed: ['✖', 'Failed'], running: ['●', 'Running now'], pending: ['○', 'Waiting'], skipped: ['–', 'Not run'] };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /** Stop testing: the step in progress finishes, finished cases keep their results, the rest are not run. */
  const stopButton = (run) => el('button', { class: 'btn danger stopbtn', text: S_STOPPING.has(run.id) ? 'Stopping…' : '■ Stop testing', disabled: S_STOPPING.has(run.id), onclick: async (e) => {
    if (!confirm('Stop testing now?\n\nThe step in progress finishes. Test cases already finished keep their results; the rest are marked "Not run" and are not counted as failures.')) return;
    S_STOPPING.add(run.id);
    e.target.disabled = true;
    e.target.textContent = 'Stopping…';
    try { await send('/runs/' + run.id + '/stop', {}); } catch (err) { fail(err); }
  } });
  const S_STOPPING = new Set();

  Ext.afterRun.push(async (run) => {
    const isCases = run.kind === 'cases';
    const active = ['queued', 'installing', 'running'].includes(run.status);
    // For test cases the Stop button sits in the progress card, where people look while it runs.
    if (isCases) $('stop').classList.add('hidden');
    $('download').classList.toggle('hidden', isCases);
    if (isCases) $('apply').classList.add('hidden');
    // The locator tiles and the Install phase mean nothing for test cases written in plain English.
    $('phases').classList.toggle('hidden', isCases);
    $('tiles').classList.toggle('hidden', isCases);
    // That note talks about locators and the log; the progress card says how a test-case run went, in plain words.
    $('verdict').classList.toggle('hidden', isCases);
    const heading = $('heals').previousElementSibling.querySelector('h3');
    if (heading) heading.textContent = isCases ? 'Elements that changed on the page (found again automatically)' : 'Locator fixes';
    if (shownRun !== run.id) {
      shownRun = run.id;
      // The raw log is for developers. Testers get the checklist; the log is one click away.
      $('logWrap').open = !isCases;
      $('logTitle').textContent = isCases ? 'Technical log (for developers)' : 'Run log';
    }
    const box = $('runSteps');
    if (!isCases) { box.replaceChildren(); stepsSig = ''; return; }
    let data;
    try { data = await get('/runs/' + run.id + '/steps'); } catch { return; }
    const sig = run.id + run.status + JSON.stringify(data);
    if (sig === stepsSig) return;
    stepsSig = sig;
    const open = new Set([...box.querySelectorAll('details[open]')].map((d) => d.dataset.id));
    // A fresh look when the page opens on a run, and again the moment the run ends: then only the failures stay open.
    const going = active || !!data.running;
    const first = box.children.length === 0 || box.dataset.run !== run.id || (box.dataset.going === '1' && !going);
    box.dataset.run = run.id;
    box.dataset.going = going ? '1' : '0';
    let cases = data.cases || [];
    // A run that has ended but left steps marked as waiting or running (it was ended by force): those never ran.
    if (!active) cases = cases.map((c) => (c.status === 'running' || c.status === 'pending' ? { ...c, status: 'skipped', steps: c.steps.map((s) => (s.status === 'running' || s.status === 'pending' ? { ...s, status: 'skipped' } : s)) } : c));
    const count = (st) => cases.filter((c) => c.status === st).length;
    const passed = count('passed'), failed = count('failed'), blocked = count('blocked'), notRun = count('skipped');
    const finished = passed + failed + blocked + notRun;
    const cur = data.current && cases[data.current.case];
    const curStep = cur && cur.steps[data.current.step];

    // The headline: what is happening now, or how it went, in one sentence.
    let title, now, tone;
    if (run.status === 'queued') {
      title = 'Waiting to start';
      now = 'Other test runs are using the server. This one starts by itself as soon as one finishes. You can stop it now and it will not run.';
      tone = 'going';
    } else if (!cases.length && run.status === 'stopped') {
      title = 'Stopped before it started';
      now = 'You stopped this run while it was waiting, so no test case was run and nothing was counted. Run it again whenever you like.';
      tone = 'done-stop';
    } else if (!cases.length) {
      title = active ? 'Getting ready…' : 'No results'; now = active ? 'Starting the browser and opening your app.' : 'The run stopped before any test case started. Open the technical log below to see why.'; tone = active ? 'going' : 'done-bad';
    } else if (run.status === 'stopped' || (!active && data.stopped && /by you/.test(data.stopped))) {
      title = `Stopped: ${passed} passed, ${failed} failed, ${notRun} not run`;
      now = 'You stopped the test run. Finished test cases keep their results; the others were not run and are not counted as failures.';
      tone = 'done-stop';
    } else if (active || data.running) {
      title = `Running test case ${Math.min(finished + 1, cases.length)} of ${cases.length}`;
      now = cur ? `${cur.id} · ${cur.title}${curStep ? ` — step ${curStep.index + 1} of ${cur.steps.length}: ${curStep.text}` : ''}` : run.status === 'queued' ? 'Waiting for a free slot on the server…' : 'Starting…';
      tone = 'going';
    } else {
      title = data.stopped ? `Stopped at the first failure: ${passed} passed, ${failed} failed, ${notRun} not run` : failed || blocked ? `${passed} of ${cases.length} test cases passed` : `All ${plural(cases.length, 'test case', 'test cases')} passed`;
      const firstBad = cases.find((c) => c.status === 'failed' || c.status === 'blocked');
      now = firstBad ? `${firstBad.id} ${firstBad.status === 'blocked' ? 'was blocked' : 'failed'}: ${(firstBad.steps.find((s) => s.status === 'failed') || {}).error || firstBad.advice || ''}` : 'Every step did what the test case said, on the real app.';
      tone = failed ? 'done-bad' : blocked ? 'done-warn' : 'done-ok';
    }
    const liveSrc = data.live ? `/api/runs/${run.id}/shots/${data.live}?t=${data.liveAt || ''}` : '';
    const shot = active || data.running
      ? el('figure', { class: 'livebox' }, liveSrc ? el('img', { src: liveSrc, alt: 'What the test browser shows now' }) : el('div', { class: 'blank', text: 'The browser picture appears after the first step.' }),
        el('figcaption', { text: liveSrc ? 'What the test browser shows now (updates after every step)' : '' }))
      : el('figure', { class: 'livebox' }, liveSrc ? el('img', { src: liveSrc, alt: 'The page at the end of the run' }) : el('div', { class: 'blank', text: 'No picture of the page was taken.' }),
        el('figcaption', { text: liveSrc ? 'The page after the last step that worked' : '' }));

    const done = cases.filter((c) => ['passed', 'failed', 'blocked'].includes(c.status));
    box.replaceChildren(
      el('div', { class: 'prog ' + tone },
        el('div', {},
          el('div', { class: 'proghead' }, el('div', {}, el('h2', { text: title }), el('p', { class: 'now', text: now })),
            active ? stopButton(run) : null),
          el('div', { class: 'segs', title: 'One block per test case' }, ...cases.map((c) => el('span', { class: c.status, title: `${c.id}: ${(CASE_WORD[c.status] || [c.status])[0]}` }))),
          el('div', { class: 'counts' },
            el('span', { class: 'ok' }, el('b', { text: '✔ ' + passed }), ' passed'),
            el('span', { class: 'bad' }, el('b', { text: '✖ ' + failed }), ' failed'),
            blocked ? el('span', { class: 'warn' }, el('b', { text: '⏸ ' + blocked }), ' blocked (page would not load)') : null,
            notRun ? el('span', { class: 'mute' }, el('b', { text: '– ' + notRun }), ' not run') : null,
            cases.length - finished ? el('span', { class: 'mute' }, el('b', { text: '○ ' + (cases.length - finished) }), active || data.running ? ' to go' : ' did not finish') : null),
          !active && !data.running && done.length ? el('div', { class: 'guided', style: 'margin-top:14px' },
            el('div', {}, el('b', { text: pct(mean(done.map((c) => c.confidence / 100))) + '%' }), el('span', { text: 'confidence in these results' })),
            el('div', {}, el('b', { text: pct(mean(done.map((c) => c.understanding / 100))) + '%' }), el('span', { text: 'steps understood' })),
            el('div', { style: 'flex:1;min-width:200px;font-size:13px;color:var(--muted)', text: 'Confidence drops when a step was only partly understood, or when an element was found by guesswork rather than by its name.' })) : null),
        shot),
      el('div', { class: 'bar' }, el('h3', { text: 'Test cases, step by step' })),
      el('div', {}, ...cases.map((c) => {
        const [word, cls] = CASE_WORD[c.status] || [c.status, 'mute'];
        const d = el('details', { class: 'case' });
        d.dataset.id = c.id;
        // Open what matters: the case running now, and failures when the run is over.
        d.open = c.status === 'running' || (first ? c.status === 'failed' || c.status === 'blocked' || cases.length <= 2 : open.has(c.id));
        const ranSteps = c.steps.filter((s) => s.status === 'passed').length;
        d.append(
          el('summary', {}, el('span', { class: 'badge b-' + cls, text: word }), el('b', { text: c.id }), el('span', { text: c.title }),
            el('span', { class: 'spacer' }), el('span', { class: 'hint', text: `${ranSteps} of ${c.steps.length} steps done` }),
            ['passed', 'failed', 'blocked'].includes(c.status) ? confPill(c.confidence / 100, 'confidence') : null),
          el('div', { class: 'body2' },
            c.advice ? el('div', { class: 'note', text: c.advice }) : null,
            el('div', {}, ...c.steps.map((s) => {
              const [ic, label] = STEP_WORD[s.status] || ['–', s.status];
              const why = s.status === 'skipped' && c.steps.some((x) => x.status === 'failed' && x.index < s.index) ? 'Not run: an earlier step failed' : label;
              return el('div', { class: 'stepres ' + s.status },
                el('span', { class: 'ic', text: ic }),
                el('span', { class: 'what' }, el('span', { class: 'st', text: why }), s.text, s.via && s.via !== 'saved' ? el('span', { class: 'tag', style: 'margin-left:8px', text: s.via === 'healed' ? 'element changed, found again' : 'found by its name' }) : null),
                s.status === 'passed' || s.status === 'failed' ? el('span', { class: 'hint', text: (s.ms / 1000).toFixed(1) + 's' }) : el('span'),
                s.status === 'passed' && s.matchedAs ? el('div', { class: 'sub', text: 'Used ' + s.matchedAs }) : null,
                s.error ? el('div', { class: 'err', text: s.error }) : null,
                s.alternatives && s.alternatives.length ? el('div', { class: 'sub', text: 'Closest matches on the page: ' + s.alternatives.slice(0, 4).join(' · ') }) : null,
                s.screenshot ? el('a', { href: `/api/runs/${run.id}/shots/${s.screenshot}`, target: '_blank' }, el('img', { src: `/api/runs/${run.id}/shots/${s.screenshot}`, alt: 'The page when this step failed' })) : null);
            }))));
        return d;
      })));
  });
  // The Copy button sits in the log's heading; copying must not also fold the log away.
  $('copyLog').addEventListener('click', (e) => e.preventDefault());

  Ext.afterReport.push((r) => {
    if (!r.guided) return;
    $('rBody').prepend(el('div', { class: 'guided' },
      el('div', {}, el('b', { text: r.guided.confidence + '%' }), el('span', { text: 'confidence in these results' })),
      el('div', {}, el('b', { text: r.guided.understanding + '%' }), el('span', { text: 'steps understood' })),
      el('div', {}, el('b', { text: String(100 - r.risk.score) + '%' }), el('span', { text: 'release confidence (100 minus residual risk)' })),
      el('div', { style: 'flex:1;min-width:220px;font-size:13px;color:var(--muted)', text: 'Results confidence is about these test cases: did we understand and run them correctly. Release confidence is about the app: what is left open or untested.' })));
  });

  /* ---------- team ---------- */
  async function renderTeam() {
    const users = await get('/users');
    const email = text('name@company.com');
    const name = text('Full name');
    const pw = el('input', { type: 'text', placeholder: 'Temporary password (8+ characters)', autocomplete: 'off' });
    const role = el('select', {}, el('option', { value: 'tester', text: 'Tester' }), el('option', { value: 'admin', text: 'Admin' }));
    const patch = async (id, change) => { try { await send('/users/' + id, change, 'PATCH'); renderTeam(); } catch (e) { fail(e); } };
    $('view-team').replaceChildren(
      el('div', { class: 'hero' }, el('h1', { text: 'Team' }), el('p', { text: 'Testers see only their own work. Admins see everything and manage accounts.' })),
      el('div', { class: 'tblwrap', style: 'margin-top:16px' }, el('table', { class: 'tbl' }, el('thead', {}, el('tr', {}, ...['Name', 'Email', 'Role', 'Status', ''].map((h) => el('th', { text: h })))),
        el('tbody', {}, ...users.map((u) => el('tr', {}, el('td', { text: u.name }), el('td', { text: u.email }),
          el('td', {}, el('select', { class: 'mini', onchange: (e) => patch(u.id, { role: e.target.value }) }, ...['tester', 'admin'].map((r) => el('option', { value: r, text: r, selected: r === u.role })))),
          el('td', {}, el('span', { class: 'badge b-' + (u.disabled ? 'bad' : 'ok'), text: u.disabled ? 'disabled' : 'active' })),
          el('td', {}, el('button', { class: 'mini', text: u.disabled ? 'Enable' : 'Disable', onclick: () => patch(u.id, { disabled: !u.disabled }) }),
            el('button', { class: 'mini', text: 'Set password', onclick: () => { const p = prompt('New password for ' + u.name + ' (8+ characters)'); if (p) patch(u.id, { password: p }); } }))))))),
      el('section', { class: 'card' }, el('h2', { text: 'Add a person' }), el('div', { class: 'adv' }, field('Name', name), field('Email', email), field('Password', pw), field('Role', role)),
        el('div', { class: 'cta' }, el('button', { class: 'btn primary', text: 'Add person', onclick: async () => { try { await send('/users', { email: email.value, name: name.value, password: pw.value, role: role.value }); toast('Added.'); renderTeam(); } catch (e) { fail(e); } } }))),
      el('div', { id: 'connections' }));
    renderConnections();
  }

  /* ---------- Jira and Azure DevOps: set up once by an admin, used by everyone to file bugs ---------- */
  const TOOLS = {
    jira: {
      name: 'Jira Cloud', icon: '🟦',
      fields: [
        ['site', 'Jira address', 'https://yourcompany.atlassian.net', 'Your Jira Cloud address.'],
        ['email', 'Account email', 'qa-bot@yourcompany.com', 'The Atlassian account that owns the API token. Tickets are created as this person.'],
        ['token', 'API token', 'Paste the API token', 'Create one at id.atlassian.com → Security → API tokens. Stored encrypted on this server and never shown again.'],
        ['project', 'Project key', 'SHOP', 'The letters before the number in ticket keys, like SHOP in SHOP-123.'],
        ['bugType', 'Bug issue type', 'Bug', 'Usually "Bug".'],
        ['storyType', 'User story issue type', 'Story', 'Usually "Story" in Jira.'],
      ],
    },
    ado: {
      name: 'Azure DevOps', icon: '🔷',
      fields: [
        ['org', 'Organization address', 'https://dev.azure.com/yourorg', 'Your Azure DevOps organization.'],
        ['token', 'Personal access token', 'Paste the token', 'User settings → Personal access tokens → New token, with "Work Items: Read & write". Stored encrypted on this server and never shown again.'],
        ['project', 'Project', 'Online Shop', 'The project name as shown in Azure DevOps.'],
        ['bugType', 'Bug work item type', 'Bug', 'Usually "Bug" (the Basic process uses "Issue").'],
        ['storyType', 'User story work item type', 'User Story', '"User Story" (Agile), "Product Backlog Item" (Scrum), "Requirement" (CMMI) or "Issue" (Basic).'],
      ],
    },
  };

  async function renderConnections() {
    const box = $('connections');
    if (!box) return;
    let summary;
    try { summary = await get('/integrations'); } catch (e) { box.replaceChildren(el('div', { class: 'err', text: e.message })); return; }
    box.replaceChildren(
      el('div', { class: 'hero', style: 'padding-bottom:0' }, el('h1', { style: 'font-size:26px', text: 'Connections' }),
        el('p', { text: 'Connect Jira or Azure DevOps once, and every tester can file a bug there from the report, linked to a user story if they like. EasyTesting then shows each ticket\'s status and adds the re-test result to it as a comment.' })),
      el('div', { class: 'conns' }, ...Object.entries(TOOLS).map(([tool, t]) => connectionCard(tool, t, summary[tool]))));
  }

  function connectionCard(tool, t, now) {
    const inputs = {};
    const msg = el('div', { class: 'hint' });
    const err = el('div', { class: 'err' });
    const body = el('div', { class: 'connform' + (now.connected ? ' hidden' : '') }, ...t.fields.map(([k, label, ph, hint]) => {
      const i = el('input', { type: k === 'token' ? 'password' : 'text', placeholder: k === 'token' && now.connected ? 'Leave blank to keep the saved token' : ph, autocomplete: 'off' });
      if (now.connected && k !== 'token') i.value = { site: now.where, org: now.where, project: now.project, bugType: now.bugType, storyType: now.storyType }[k] || '';
      inputs[k] = i;
      return field(label, i, hint);
    }));
    const values = () => Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()]));
    const busy = async (btn, label, fn) => {
      err.textContent = ''; msg.textContent = '';
      const was = btn.textContent; btn.disabled = true; btn.textContent = label;
      try { await fn(); } catch (e) { err.textContent = e.message; }
      btn.disabled = false; btn.textContent = was;
    };
    const testBtn = el('button', { class: 'btn', text: 'Test connection', onclick: (e) => busy(e.target, 'Testing…', async () => { msg.textContent = '✔ ' + (await send(`/integrations/${tool}/test`, values())).message; }) });
    const saveBtn = el('button', { class: 'btn primary', text: now.connected ? 'Save changes' : 'Connect', onclick: (e) => busy(e.target, 'Checking…', async () => {
      const out = await send(`/integrations/${tool}`, values(), 'PUT');
      toast(out.message); renderConnections();
    }) });
    const removeBtn = now.connected ? el('button', { class: 'btn danger', text: 'Disconnect', onclick: async () => {
      if (!confirm(`Disconnect ${t.name}? Tickets already filed stay linked, but no new ones can be filed and their status stops updating.`)) return;
      try { await send(`/integrations/${tool}`, {}, 'DELETE'); renderConnections(); } catch (e) { fail(e); }
    } }) : null;
    const edit = now.connected ? el('button', { class: 'btn', text: 'Change settings', onclick: (e) => { body.classList.remove('hidden'); actions.classList.remove('hidden'); e.target.remove(); } }) : null;
    const actions = el('div', { class: 'cta' + (now.connected ? ' hidden' : '') }, saveBtn, testBtn);
    return el('section', { class: 'card conn' },
      el('div', { class: 'gaphead' }, el('h2', { style: 'margin:0', text: `${t.icon} ${t.name}` }),
        el('span', { class: 'badge b-' + (now.connected ? 'ok' : 'mute'), text: now.connected ? 'Connected' : 'Not connected' })),
      now.connected ? el('p', { class: 'hint', text: `Project ${now.project} at ${now.where}. Bugs are filed as "${now.bugType}" and can be linked to a "${now.storyType}".` }) : null,
      body, actions, el('div', { class: 'row' }, edit, removeBtn), msg, err);
  }
})();
