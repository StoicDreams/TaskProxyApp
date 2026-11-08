import { test, expect } from './support/app.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// These fail when something new has no tests, or when the frontend and backend disagree, naming what is wrong.
const path = relative => fileURLToPath(new URL(relative, import.meta.url));
const read = relative => readFileSync(path(relative), 'utf8');
const specs = readdirSync(path('./components')).filter(name => name.endsWith('.spec.mjs')).map(name => name.replace('.spec.mjs', ''));
// template.js is the starting point for new components, and is never loaded.
const components = readdirSync(path('../wc')).filter(name => name.endsWith('.js') && !name.endsWith('.min.js')).map(name => name.replace('.js', '')).filter(name => name !== 'template');
const registered = [...read('../src-tauri/src/lib.rs').matchAll(/services::\w+::(\w+),|appdata::(\w+),/g)].map(match => match[1] || match[2]);
const invoked = [...read('../root_files/app.js').matchAll(/(?:invoke|invokeGit)\('(\w+)'/g)].map(match => match[1]);

test('every component has a spec file', () => {
    expect(components.filter(name => !specs.includes(name))).toEqual([]);
});
test('every spec file belongs to a component', () => {
    expect(specs.filter(name => !components.includes(name))).toEqual([]);
});
test('every command the frontend calls is registered in the backend', () => {
    expect(invoked.filter(name => !registered.includes(name))).toEqual([]);
});
test('every registered command is reachable from the frontend', () => {
    // greet is the example command from the Tauri template.
    expect(registered.filter(name => !invoked.includes(name) && name !== 'greet')).toEqual([]);
});
test('the mock backend answers every registered command', () => {
    const mock = read('./support/backend.mjs');
    expect(registered.filter(name => !mock.includes(`${name}:`) && name !== 'greet')).toEqual([]);
});
test('app.min.css has every rule in app.css', () => {
    // The app loads app.min.css, so a rule missing from it never reaches the app, while npm test still passes on app.css.
    const selectors = css => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
        .map(match => match[1].replace(/::(before|after)/g, ':$1').replace(/\s*([>+~,])\s*/g, '$1').replace(/\s+/g, ' ').trim());
    const minified = selectors(read('../css/app.min.css'));
    expect(selectors(read('../css/app.css')).filter(selector => !minified.includes(selector)), 'Regenerate css/app.min.css from css/app.css').toEqual([]);
});
