import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseStep } from '../src/cases/steps.js';

type Want = Partial<ReturnType<typeof parseStep>>;
const cases: [string, Want][] = [
  // open / navigation
  ['Open https://shop.example.com/login', { action: 'open', value: 'https://shop.example.com/login' }],
  ['Navigate to /settings', { action: 'open', value: '/settings' }],
  ['Open "/text-box"', { action: 'open', value: '/text-box' }],
  ["Go to '/account/settings?tab=billing'", { action: 'open', value: '/account/settings?tab=billing' }],
  ['Open "https://shop.example.com/login"', { action: 'open', value: 'https://shop.example.com/login' }],
  ['Open elements/text-box', { action: 'open', value: 'elements/text-box' }],
  ['Launch the application', { action: 'open', value: '' }],
  ['Go to the login page', { action: 'open', target: 'login' }],
  ['Refresh the page', { action: 'refresh' }],
  ['Go back', { action: 'back' }],
  // click
  ['Click the Sign in button', { action: 'click', target: 'Sign in', hint: 'button' }],
  ['Click on "Forgot password?" link', { action: 'click', target: 'Forgot password?', hint: 'link' }],
  ['Press the Save button', { action: 'click', target: 'Save', hint: 'button' }],
  ["Tap 'Checkout'", { action: 'click', target: 'Checkout' }],
  ['1. Click Login', { action: 'click', target: 'Login' }],
  ['Step 2: click the Billing tab', { action: 'click', target: 'Billing', hint: 'tab' }],
  // type
  ['Enter "a@b.co" in the Email field', { action: 'type', target: 'Email', hint: 'field', value: 'a@b.co' }],
  ['Type "secret pass" into the Password field', { action: 'type', target: 'Password', value: 'secret pass' }],
  ['Enter the Username as "sam"', { action: 'type', target: 'Username', value: 'sam' }],
  ['Fill in "Sam" in First name', { action: 'type', target: 'First name', value: 'Sam' }],
  ['Enter a valid email in the Email field', { action: 'type', target: 'Email', value: 'tester@example.com' }],
  ['Enter an invalid email in the Email field', { action: 'type', target: 'Email', value: 'not-an-email' }],
  ['Leave the Email field empty', { action: 'clear', target: 'Email' }],
  ['Clear the Search box', { action: 'clear', target: 'Search' }],
  ['Enter John in the Name field', { action: 'type', target: 'Name', value: 'John' }],
  // select / check
  ['Select "India" from the Country dropdown', { action: 'select', target: 'Country', value: 'India' }],
  ['Choose Medium from Priority', { action: 'select', target: 'Priority', value: 'Medium' }],
  ['Check the Remember me checkbox', { action: 'check', target: 'Remember me', hint: 'checkbox' }],
  ['Tick the Terms box', { action: 'check', target: 'Terms' }],
  ['Uncheck the Newsletter checkbox', { action: 'uncheck', target: 'Newsletter' }],
  // press / wait
  ['Press Enter', { action: 'press', value: 'Enter' }],
  ['Wait 3 seconds', { action: 'wait', value: '3000' }],
  ['Wait for the spinner to disappear', { action: 'verify' }],
  // verify: text
  ['Verify "Welcome back" is displayed', { action: 'verify', check: 'text', value: 'Welcome back' }],
  ['Verify that the text "Order placed" is shown', { action: 'verify', check: 'text', value: 'Order placed' }],
  ['The page displays "Dashboard"', { action: 'verify', check: 'text', value: 'Dashboard' }],
  ['Check that "Saved" appears', { action: 'verify', check: 'text', value: 'Saved' }],
  // verify: messages
  ['Verify an error message is displayed', { action: 'verify', check: 'message', kind: 'error' }],
  ['Verify the error message "Enter a valid email address" is displayed', { action: 'verify', check: 'text', value: 'Enter a valid email address', kind: 'error' }],
  ['An error message saying "Wrong password" appears', { action: 'verify', check: 'text', value: 'Wrong password' }],
  ['Verify no error message is shown', { action: 'verify', check: 'no-message' }],
  // verify: state
  ['Verify the Save button is disabled', { action: 'verify', check: 'disabled', target: 'Save', hint: 'button' }],
  ['Verify the Submit button is enabled', { action: 'verify', check: 'enabled', target: 'Submit' }],
  ['The Remember me checkbox is checked', { action: 'verify', check: 'checked', target: 'Remember me' }],
  ['Verify the Delete button is not displayed', { action: 'verify', check: 'hidden', target: 'Delete' }],
  ['Verify "Thanks for submitting the form" is not displayed', { action: 'verify', check: 'no-text', value: 'Thanks for submitting the form' }],
  ['Verify that "Welcome" does not appear', { action: 'verify', check: 'no-text', value: 'Welcome' }],
  ['Verify the text "Welcome" is not visible', { action: 'verify', check: 'no-text', value: 'Welcome' }],
  ['"Saved" should not be shown', { action: 'verify', check: 'no-text', value: 'Saved' }],
  ['The error message "Oops" is no longer displayed', { action: 'verify', check: 'no-text', value: 'Oops' }],
  ['The Save button does not appear', { action: 'verify', check: 'hidden', target: 'Save' }],
  ['Verify "Welcome" is displayed', { action: 'verify', check: 'text', value: 'Welcome' }],
  ['Dashboard is displayed', { action: 'verify', check: 'visible', target: 'Dashboard' }],
  // verify: title / url / page
  ['Verify the page title is "Acme - Billing"', { action: 'verify', check: 'title', value: 'Acme - Billing', exact: true }],
  ['Verify the page title contains "Billing"', { action: 'verify', check: 'title', value: 'Billing', exact: false }],
  ['Verify the URL contains "/billing"', { action: 'verify', check: 'url', value: '/billing', exact: false }],
  ['User is redirected to the dashboard page', { action: 'verify', check: 'page', value: 'dashboard' }],
  ['Verify the user is redirected to https://x.io/home', { action: 'verify', check: 'url', value: 'https://x.io/home' }],
  // verify: field value
  ['Verify the Email field contains "a@b.co"', { action: 'verify', check: 'value', target: 'Email', value: 'a@b.co' }],
];

describe('step reader', () => {
  for (const [text, want] of cases) {
    it(text, () => {
      const got = parseStep(text);
      for (const [k, v] of Object.entries(want)) {
        assert.deepEqual((got as any)[k], v, `${k} of ${JSON.stringify(got)}`);
      }
      assert.ok(got.confidence >= 0.5, `confident enough to run unprompted: ${got.confidence} ${JSON.stringify(got)}`);
    });
  }

  it('says so when it cannot read a step, instead of guessing', () => {
    for (const text of ['Do the needful', 'Make the system happy', 'Observe behaviour of module', '', 'asdf qwer']) {
      const got = parseStep(text);
      assert.ok(got.action === 'unknown' || got.confidence < 0.6, `${JSON.stringify(text)} -> ${JSON.stringify(got)}`);
    }
  });

  it('is less sure when the text to type is not in quotes', () => {
    const quoted = parseStep('Enter "John" in the Name field');
    const bare = parseStep('Enter John in the Name field');
    assert.ok(quoted.confidence > bare.confidence);
    assert.ok(bare.notes.length > 0);
  });

  it('does not treat "check that" as ticking a box, nor "check the X box" as a verification', () => {
    assert.equal(parseStep('Check that the Save button is enabled').action, 'verify');
    assert.equal(parseStep('Check the Remember me box').action, 'check');
  });
});

describe('steps written the way testers usually write them', () => {
  const read = (s: string) => parseStep(s);
  it('reads "Field: value", "Field "value"" and "Fill X with Y"', () => {
    assert.deepEqual([read('Enter Username: admin')].map((p) => [p.action, p.target, p.value]), [['type', 'Username', 'admin']]);
    assert.deepEqual([read('Enter Password = secret123')].map((p) => [p.action, p.target, p.value]), [['type', 'Password', 'secret123']]);
    assert.deepEqual([read('Enter username "admin"')].map((p) => [p.action, p.target, p.value]), [['type', 'username', 'admin']]);
    assert.deepEqual([read('Fill the Full Name field with John')].map((p) => [p.action, p.target, p.value]), [['type', 'Full Name', 'John']]);
    for (const s of ['Enter Username: admin', 'Enter username "admin"', 'Fill the Full Name field with John']) assert.ok(read(s).confidence >= 0.75, s);
  });
  it('understands a field named without its value, and asks for the value instead of scoring 0', () => {
    for (const s of ['Enter valid username', 'Enter valid password', 'Enter email id', 'Enter OTP']) {
      const p = read(s);
      assert.equal(p.action, 'type', s);
      assert.equal(p.needsValue, true, s);
      assert.ok(p.confidence > 0.4 && p.confidence < 0.6, `${s}: ${p.confidence}`);
      assert.match(p.notes[0], /Add the text in quotes/);
    }
    assert.equal(read('Enter invalid password').value, 'Wrong-Pass-123', 'a wrong password can be made up');
    assert.equal(read('Enter a valid email').value, 'tester@example.com');
  });
  it('reads search and log out, and refuses steps that cover several fields', () => {
    assert.deepEqual([read('Search for "laptop"')].map((p) => [p.action, p.target, p.value]), [['type', 'Search', 'laptop']]);
    assert.deepEqual([read('Logout from the application')].map((p) => [p.action, p.target]), [['click', 'Logout']]);
    for (const s of ['Provide valid credentials', 'Fill the form with valid data', 'Enter the details']) assert.equal(read(s).action, 'unknown', s);
  });
  it('keeps "Submit the form" a click', () => {
    assert.equal(read('Submit the form').action, 'click');
  });
});
