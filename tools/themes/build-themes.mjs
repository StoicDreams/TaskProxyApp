// Builds Task Proxy's themes: the CSS between the THEMES markers in css/app.css, and the options between the THEMES
// markers in index.html's webui-theme-selector. Each theme is a concept, like the themes of StoicDreams.com and
// ErikGassler.com: its colors, a heading font, a texture behind the page, a mark beside section headings, a way of
// drawing those headings, and a look for page segments. Headings and segments are drawn through Web UI's theme
// variables (--heading-*, --segment-*, --font-family-display), which reach page content inside shadow roots. Change the THEMES table below, then run:
//
//     node tools/themes/build-themes.mjs
//
// and Minify.ps1 after it. Fonts are font stacks of fonts that ship with Windows, macOS or Linux, as the app's
// content security policy loads no web fonts.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Heading fonts, by feel. */
const FONTS = {
    rounded: '"Nunito", "Varela Round", "Arial Rounded MT Bold", "Segoe UI", system-ui, sans-serif',
    geometric: '"Futura", "Century Gothic", "Avenir Next", "Trebuchet MS", system-ui, sans-serif',
    serif: '"Palatino Linotype", "Book Antiqua", Palatino, "URW Palladio L", Georgia, serif',
    chiseled: '"Copperplate", "Copperplate Gothic Light", "Trajan Pro", "Palatino Linotype", Georgia, serif',
    hand: '"Segoe Print", "Bradley Hand", "Chalkboard SE", "Comic Neue", "Comic Sans MS", cursive',
    mono: '"Cascadia Code", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    tech: '"Bahnschrift", "DIN Alternate", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif',
    slab: '"Rockwell", "Roboto Slab", "Clarendon", "Courier New", Georgia, serif',
    humanist: '"Optima", "Candara", "Segoe UI", "Fira Sans", system-ui, sans-serif',
    poster: '"Impact", "Haettenschweiler", "Arial Black", "Franklin Gothic Heavy", sans-serif',
    elegant: '"Didot", "Bodoni MT", "Bodoni 72", "Libre Bodoni", Georgia, serif',
};
/** Fonts drawn in capitals, spaced out. */
const CAPS = new Set(['chiseled', 'tech']);

/**
 * Textures behind the page, tiled. `ink` is the texture's color and `o` its strength. Each returns an SVG.
 */
const TEXTURES = {
    noise: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='3' seed='7' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 ${ink.map(c => (c / 255).toFixed(2)).join(' 0 0 0 0 ')} 0 0 0 ${(o * 1.6).toFixed(3)} 0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`,
    grid: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28'><path d='M28 0H0V28' fill='none' stroke='${hex(ink)}' stroke-opacity='${o}' stroke-width='1'/></svg>`,
    blueprint: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'><g fill='none' stroke='${hex(ink)}'><path d='M96 0H0V96' stroke-opacity='${o * 2}' stroke-width='1.2'/><path d='M24 0V96M48 0V96M72 0V96M0 24H96M0 48H96M0 72H96' stroke-opacity='${o}' stroke-width='0.6'/></g></svg>`,
    dots: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18'><circle cx='9' cy='9' r='1.3' fill='${hex(ink)}' fill-opacity='${o * 1.5}'/></svg>`,
    halftone: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14'><circle cx='3.5' cy='3.5' r='2.2' fill='${hex(ink)}' fill-opacity='${o * 1.3}'/><circle cx='10.5' cy='10.5' r='2.2' fill='${hex(ink)}' fill-opacity='${o * 1.3}'/></svg>`,
    iso: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='56' viewBox='0 0 48 56'><g fill='none' stroke='${hex(ink)}' stroke-opacity='${o}' stroke-width='1'><path d='M24 4l20 12v24L24 52 4 40V16z'/><path d='M4 16l20 12 20-12M24 28v24'/></g></svg>`,
    hatch: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'><path d='M-1 9L9 -1' stroke='${hex(ink)}' stroke-opacity='${o * 1.2}' stroke-width='0.8'/></svg>`,
    stripes: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28'><path d='M-7 35L35 -7M-21 21L21 -21M7 49L49 7' stroke='${hex(ink)}' stroke-opacity='${o}' stroke-width='6'/></svg>`,
    scan: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4'><rect width='4' height='1' fill='${hex(ink)}' fill-opacity='${o * 1.4}'/></svg>`,
    waves: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='60' height='20'><path d='M0 10c10-8 20-8 30 0s20 8 30 0' fill='none' stroke='${hex(ink)}' stroke-opacity='${o * 1.5}' stroke-width='1.2'/></svg>`,
    dunes: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='48'><g fill='none' stroke='${hex(ink)}' stroke-opacity='${o * 1.3}' stroke-width='1'><path d='M0 16c40-10 80 10 160 0'/><path d='M0 38c50-12 100 8 160-2'/></g></svg>`,
    grain: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='40'><g fill='none' stroke='${hex(ink)}' stroke-opacity='${o * 1.3}' stroke-width='0.8'><path d='M0 6c50 4 90-4 200 2'/><path d='M0 17c60-5 110 6 200-1'/><path d='M0 29c40 3 120-6 200 3'/><path d='M60 36c20-3 40-3 60 0'/></g></svg>`,
    topo: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><g fill='none' stroke='${hex(ink)}' stroke-opacity='${o * 1.3}' stroke-width='1'><path d='M80 30c30 0 50 20 46 48s-30 44-56 40-42-28-38-52 20-36 48-36z'/><path d='M80 50c18 0 30 12 28 30s-18 26-34 24-26-16-24-30 12-24 30-24z'/><path d='M0 150c30-20 60 10 100-6s50-10 60-4'/></g></svg>`,
    circuit: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><g fill='none' stroke='${hex(ink)}' stroke-opacity='${o * 1.4}' stroke-width='1.2'><path d='M0 20h24l12 12h20M56 32v28l-10 10H0M80 56H64'/><circle cx='56' cy='32' r='2.5'/><circle cx='64' cy='56' r='2.5'/></g></svg>`,
    stars: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><g fill='${hex(ink)}' fill-opacity='${Math.min(1, o * 5)}'><circle cx='20' cy='30' r='1'/><circle cx='90' cy='12' r='0.7'/><circle cx='150' cy='60' r='1.2'/><circle cx='60' cy='100' r='0.8'/><circle cx='120' cy='140' r='1'/><circle cx='30' cy='160' r='0.6'/><circle cx='170' cy='170' r='0.7'/><circle cx='100' cy='80' r='0.5'/></g></svg>`,
    bubbles: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><g fill='none' stroke='${hex(ink)}' stroke-opacity='${o * 1.6}' stroke-width='1'><circle cx='20' cy='24' r='6'/><circle cx='80' cy='50' r='10'/><circle cx='40' cy='96' r='4'/><circle cx='104' cy='104' r='3'/></g></svg>`,
    leaves: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='90' height='90'><g fill='${hex(ink)}' fill-opacity='${o * 1.1}'><path d='M20 30c0-12 10-20 22-20 0 12-10 20-22 20z'/><path d='M62 70c4-10 16-14 26-10-4 10-16 14-26 10z'/></g></svg>`,
    petals: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><g fill='${hex(ink)}' fill-opacity='${o * 1.1}'><ellipse cx='24' cy='26' rx='7' ry='3.5' transform='rotate(30 24 26)'/><ellipse cx='74' cy='68' rx='6' ry='3' transform='rotate(-40 74 68)'/><ellipse cx='70' cy='18' rx='4' ry='2' transform='rotate(70 70 18)'/></g></svg>`,
    confetti: (ink, o, colors) => `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><g fill-opacity='${Math.min(1, o * 5)}'><rect x='14' y='18' width='8' height='3' fill='${colors[0]}' transform='rotate(25 18 20)'/><rect x='70' y='30' width='7' height='3' fill='${colors[1]}' transform='rotate(-30 74 31)'/><circle cx='100' cy='80' r='2.5' fill='${colors[2]}'/><rect x='34' y='86' width='8' height='3' fill='${colors[3]}' transform='rotate(60 38 88)'/><circle cx='50' cy='54' r='2' fill='${colors[0]}'/></g></svg>`,
    rain: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='40' height='60'><g stroke='${hex(ink)}' stroke-opacity='${o * 1.6}' stroke-width='1' stroke-linecap='round'><path d='M8 4l-4 12M28 26l-4 12M18 46l-3 9'/></g></svg>`,
    craters: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><g fill='none' stroke='${hex(ink)}' stroke-opacity='${o * 1.5}' stroke-width='1'><circle cx='30' cy='40' r='14'/><circle cx='100' cy='90' r='22'/><circle cx='70' cy='20' r='5'/><circle cx='34' cy='112' r='8'/></g></svg>`,
    streaks: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><g stroke='${hex(ink)}' stroke-opacity='${o * 1.5}' stroke-width='1' stroke-linecap='round'><path d='M10 70l50-30M90 150l50-30M100 30l30-18'/></g></svg>`,
    tiles: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><path d='M20 2l18 18-18 18L2 20z' fill='none' stroke='${hex(ink)}' stroke-opacity='${o * 1.2}' stroke-width='1'/></svg>`,
    hex: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='42' height='48' viewBox='0 0 42 48'><path d='M21 0l21 12v24L21 48 0 36V12z' fill='none' stroke='${hex(ink)}' stroke-opacity='${o}' stroke-width='1'/></svg>`,
    ruled: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='10' height='32'><path d='M0 31.5H10' stroke='${hex(ink)}' stroke-opacity='${o * 1.6}' stroke-width='1'/></svg>`,
    triangles: (ink, o) => `<svg xmlns='http://www.w3.org/2000/svg' width='56' height='48'><path d='M0 48L28 0l28 48z' fill='none' stroke='${hex(ink)}' stroke-opacity='${o}' stroke-width='1'/></svg>`,
};

/** Marks beside section headings, in the theme's accents `a` and `b`, and `c` its third. Each returns an SVG. */
const MARKS = {
    diamond: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/></linearGradient></defs><path d='M12 2l10 10-10 10L2 12z' fill='url(#g)'/></svg>`,
    cube: (a, b, c) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 2l9 5-9 5-9-5z' fill='${a}'/><path d='M3 7l9 5v10l-9-5z' fill='${b}'/><path d='M21 7l-9 5v10l9-5z' fill='${c}'/></svg>`,
    squiggle: a => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M3 13c3-1 6-2 9-1s5 3 9 1M4 9c4 0 7-1 10 0s4 2 6 1M5 17c3-1 6-1 9 0s4 1 6-1' fill='none' stroke='${a}' stroke-width='2' stroke-linecap='round'/></svg>`,
    rule: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M2 12h7M15 12h7' stroke='${a}' stroke-width='1.5'/><path d='M12 8l4 4-4 4-4-4z' fill='${b}'/></svg>`,
    circle: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='8' fill='${a}'/><circle cx='15' cy='9' r='3' fill='${b}' fill-opacity='0.8'/></svg>`,
    triangle: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 3l10 18H2z' fill='${a}'/><path d='M12 3l5 18H2z' fill='${b}' fill-opacity='0.7'/></svg>`,
    star: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 2l2.9 6.9 7.1.6-5.4 4.7 1.7 7-6.3-3.9-6.3 3.9 1.7-7L2 9.5l7.1-.6z' fill='${a}' stroke='${b}' stroke-width='1'/></svg>`,
    sparkle: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 1c1 6 5 10 11 11-6 1-10 5-11 11-1-6-5-10-11-11 6-1 10-5 11-11z' fill='${a}'/><circle cx='20' cy='4' r='2' fill='${b}'/></svg>`,
    leaf: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M4 20C4 10 10 4 21 3c0 11-6 17-17 17z' fill='${a}'/><path d='M4 20L15 9' stroke='${b}' stroke-width='1.5' stroke-linecap='round'/></svg>`,
    flower: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><g fill='${a}'><circle cx='12' cy='6' r='4'/><circle cx='18' cy='12' r='4'/><circle cx='12' cy='18' r='4'/><circle cx='6' cy='12' r='4'/></g><circle cx='12' cy='12' r='3' fill='${b}'/></svg>`,
    sprout: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 22V11' stroke='${b}' stroke-width='2' stroke-linecap='round'/><path d='M12 12C12 6 8 3 3 3c0 5 4 9 9 9zM12 10c0-5 4-8 9-8 0 5-4 8-9 8z' fill='${a}'/></svg>`,
    bolt: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M14 1L4 14h7l-2 9 11-14h-7z' fill='${a}' stroke='${b}' stroke-width='1' stroke-linejoin='round'/></svg>`,
    chip: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect x='6' y='6' width='12' height='12' rx='2' fill='${a}'/><path d='M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4' stroke='${b}' stroke-width='1.6'/></svg>`,
    marker: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M3 21l3-7L16 4l4 4-10 10z' fill='${a}'/><path d='M3 21l3-7 4 4z' fill='${b}'/></svg>`,
    burst: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 1l2.5 5 5-2.5-1.5 5.5 5 2-5 2.5 2 5-5.5-1.5-2.5 5-2.5-5L3 19l2-5-5-2.5 5-2-1.5-5.5 5 2.5z' fill='${a}' stroke='${b}' stroke-width='1'/></svg>`,
    mountain: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M1 21L9 7l5 8 3-4 6 10z' fill='${a}'/><path d='M9 7l2.5 4-2.5 1.5L6.5 12z' fill='${b}'/></svg>`,
    bean: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><ellipse cx='12' cy='12' rx='7' ry='10' transform='rotate(30 12 12)' fill='${a}'/><path d='M8 5c4 3 4 11 8 14' fill='none' stroke='${b}' stroke-width='1.6' stroke-linecap='round'/></svg>`,
    quill: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M21 2C12 3 6 9 5 18l2 1c2-8 7-13 14-17z' fill='${a}'/><path d='M3 22l4-5' stroke='${b}' stroke-width='1.8' stroke-linecap='round'/></svg>`,
    sun: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='5' fill='${a}'/><path d='M12 1v4M12 19v4M1 12h4M19 12h4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M4.2 19.8L7 17M17 7l2.8-2.8' stroke='${b}' stroke-width='1.6' stroke-linecap='round'/></svg>`,
    tile: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect x='3' y='3' width='8' height='8' fill='${a}'/><rect x='13' y='13' width='8' height='8' fill='${a}'/><rect x='13' y='3' width='8' height='8' fill='${b}'/><rect x='3' y='13' width='8' height='8' fill='${b}'/></svg>`,
    moon: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M15 2a10 10 0 1 0 7 15A8 8 0 0 1 15 2z' fill='${a}'/><circle cx='19' cy='5' r='1.3' fill='${b}'/></svg>`,
    cloud: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M6 19a4 4 0 0 1 0-8 6 6 0 0 1 11.5-1.5A4.5 4.5 0 0 1 18 19z' fill='${a}'/><path d='M6 19h12' stroke='${b}' stroke-width='1.5' stroke-linecap='round'/></svg>`,
    stormcloud: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M6 15a4 4 0 0 1 0-8 6 6 0 0 1 11.5-1.5A4.5 4.5 0 0 1 18 15z' fill='${a}'/><path d='M12 13l-3 5h3l-2 5 5-7h-3l2-3z' fill='${b}'/></svg>`,
    wave: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M1 10c3-3 5-3 8 0s5 3 8 0 4-3 6-1' fill='none' stroke='${a}' stroke-width='2.2' stroke-linecap='round'/><path d='M1 16c3-3 5-3 8 0s5 3 8 0 4-3 6-1' fill='none' stroke='${b}' stroke-width='2.2' stroke-linecap='round'/></svg>`,
    feather: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M20 3C10 4 5 10 5 19c9 0 15-5 15-16z' fill='${a}' fill-opacity='0.85'/><path d='M3 21L15 9' stroke='${b}' stroke-width='1.5' stroke-linecap='round'/></svg>`,
    planet: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='6.5' fill='${a}'/><ellipse cx='12' cy='12' rx='11' ry='3.5' transform='rotate(-20 12 12)' fill='none' stroke='${b}' stroke-width='1.6'/></svg>`,
    comet: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='17' cy='7' r='4' fill='${a}'/><path d='M14 10L2 22M12 7L4 15M17 12l-7 7' stroke='${b}' stroke-width='1.6' stroke-linecap='round'/></svg>`,
    drop: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 2C8 8 5 11.5 5 15a7 7 0 0 0 14 0c0-3.5-3-7-7-13z' fill='${a}'/><path d='M9 15a3 3 0 0 0 3 3' fill='none' stroke='${b}' stroke-width='1.6' stroke-linecap='round'/></svg>`,
    shell: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 21L3 9a10 10 0 0 1 18 0z' fill='${a}'/><path d='M12 21L8 5M12 21V4M12 21l4-16' stroke='${b}' stroke-width='1.2'/></svg>`,
    crosshair: (a, b) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='7' fill='none' stroke='${a}' stroke-width='2'/><path d='M12 1v6M12 17v6M1 12h6M17 12h6' stroke='${b}' stroke-width='2'/></svg>`,
};

/**
 * Looks for page segments, as Web UI's segment variables. `ink` is the theme's text color, `a` and `b` its heading
 * accents. Each returns the variables' values.
 */
const SEGMENTS = {
    glass: ({ ink }) => ({ background: mix(ink, 5), border: `1px solid ${mix(ink, 12)}`, radius: '14px', filter: 'blur(6px)' }),
    carved: ({ dark }) => ({ background: dark ? 'rgb(0 0 0 / 18%)' : 'rgb(255 255 255 / 45%)', radius: '3px', shadow: `inset 1px 1px 0 rgb(255 255 255 / ${dark ? 7 : 70}%), inset -1px -1px 0 rgb(0 0 0 / ${dark ? 45 : 14}%), 0 2px 6px rgb(0 0 0 / ${dark ? 35 : 10}%)` }),
    sketch: ({ ink }) => ({ background: mix(ink, 3), border: `1.6px solid ${mix(ink, 70)}`, radius: '255px 12px 225px 12px / 12px 225px 12px 255px', shadow: `2px 3px 0 -1px ${mix(ink, 35)}` }),
    card: ({ dark }) => ({ background: dark ? 'rgb(255 255 255 / 4%)' : 'rgb(255 255 255 / 70%)', radius: '10px', shadow: `0 1px 2px rgb(0 0 0 / ${dark ? 30 : 8}%), 0 6px 18px rgb(0 0 0 / ${dark ? 25 : 8}%)` }),
    paper: ({ dark }) => ({ background: dark ? 'rgb(255 255 255 / 5%)' : 'rgb(255 255 255 / 65%)', radius: '2px', shadow: `0 1px 3px rgb(0 0 0 / ${dark ? 40 : 18}%), 0 0 0 1px rgb(0 0 0 / ${dark ? 20 : 4}%)` }),
    neon: ({ a }) => ({ background: mix(a, 6), border: `1px solid ${a}`, radius: '4px', shadow: `0 0 10px ${mix(a, 45)}, inset 0 0 14px ${mix(a, 15)}` }),
    comic: ({ ink, dark }) => ({ background: dark ? 'rgb(255 255 255 / 5%)' : '#ffffff', border: `3px solid ${ink}`, radius: '2px', shadow: `6px 6px 0 ${ink}` }),
    organic: ({ a }) => ({ background: mix(a, 7), border: `1px solid ${mix(a, 25)}`, radius: '28px 6px 28px 6px' }),
    pill: ({ a }) => ({ background: mix(a, 9), radius: '22px' }),
    angled: ({ a, b }) => ({ background: 'transparent', image: `linear-gradient(135deg, ${mix(a, 14)}, ${mix(b, 6)})`, clip: 'polygon(16px 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%, 0 16px)' }),
    ruled: ({ ink, a }) => ({ background: mix(ink, 4), radius: '0 8px 8px 0', shadow: `inset 4px 0 0 ${a}` }),
    dashed: ({ a }) => ({ background: mix(a, 5), border: `1px dashed ${mix(a, 60)}`, radius: '2px' }),
};

/** Ways of drawing section headings, as Web UI's heading variables, given the accents. */
const HEADINGS = {
    gradient: ({ a, b }) => ({ color: 'transparent', fill: `linear-gradient(90deg, ${a}, ${b})`, clip: 'text' }),
    glow: ({ a }) => ({ color: a, shadow: `0 0 6px ${mix(a, 70)}, 0 0 18px ${mix(a, 35)}` }),
    solid: ({ a }) => ({ color: a }),
    highlight: ({ ink, b }) => ({ color: ink, decoration: `underline ${mix(b, 45)} 0.35em` }),
    shadow: ({ a, ink }) => ({ color: a, shadow: `2px 2px 0 ${mix(ink, 85)}` }),
};

/**
 * The themes: value, name, scheme, category, colors (background, title, primary, secondary, tertiary, active,
 * button), font, texture, mark, heading, segment, and glows (soft lights behind the page: 'top', 'bottom', 'both').
 * The default theme (an empty value) is Web UI's own look, so only its tile is listed.
 */
const THEMES = [
    // Classic
    ['', 'Task Proxy', 'dark', 'Classic', '#333333 #1878af #5e0592 #0c2ec2 #7d0b77 #1f705c #1878af'],
    ['graphite', 'Graphite', 'dark', 'Classic', '#282c34 #21252b #61afef #3e4451 #c678dd #98c379 #528bff', 'hand', 'hatch', 'squiggle', 'solid', 'sketch'],
    ['charcoal', 'Charcoal', 'dark', 'Classic', '#2b2b2b #3c3f41 #4a88c7 #45494a #9876aa #6a8759 #365880', 'chiseled', 'noise', 'diamond', 'solid', 'carved'],
    ['daylight', 'Daylight', 'light', 'Classic', '#f4f5f7 #1e5fa8 #3b4fd8 #dde3ec #b4237d #0f766e #1d4ed8', 'rounded', 'dots', 'diamond', 'gradient', 'card', 'both'],
    ['porcelain', 'Porcelain', 'light', 'Classic', '#fafafa #383a42 #4078f2 #e5e5e6 #a626a4 #50a14f #0184bc', 'elegant', 'tiles', 'rule', 'solid', 'paper'],
    ['linen', 'Linen', 'light', 'Classic', '#ffffff #24292f #0969da #eaeef2 #8250df #1a7f37 #2da44e', 'serif', 'noise', 'quill', 'solid', 'paper'],
    // Colors
    ['mocha', 'Pastel Mocha', 'dark', 'Colors', '#1e1e2e #313244 #cba6f7 #45475a #f5c2e7 #a6e3a1 #89b4fa', 'rounded', 'dots', 'circle', 'gradient', 'pill', 'both'],
    ['nocturne', 'Nocturne', 'dark', 'Colors', '#282a36 #44475a #bd93f9 #3a3c4e #ff79c6 #50fa7b #8be9fd', 'geometric', 'iso', 'cube', 'gradient', 'glass', 'top'],
    ['prism', 'Prism', 'dark', 'Colors', '#1b1b29 #2d1b4e #ff6b6b #3b3b55 #ffd93d #6bcb77 #4d96ff', 'poster', 'triangles', 'triangle', 'gradient', 'angled', 'both'],
    ['latte', 'Pastel Latte', 'light', 'Colors', '#eff1f5 #dce0e8 #8839ef #ccd0da #ea76cb #40a02b #1e66f5', 'rounded', 'dots', 'circle', 'gradient', 'pill', 'top'],
    ['sherbet', 'Sherbet', 'light', 'Colors', '#fff7f0 #ff8c69 #e85d75 #ffe3d3 #7a5cfa #2fa36b #f97316', 'rounded', 'halftone', 'drop', 'highlight', 'pill'],
    ['confetti', 'Confetti', 'light', 'Colors', '#fbfbff #5b2a86 #e63946 #e9e7f5 #2a9d8f #f4a261 #3a86ff', 'geometric', 'confetti', 'star', 'solid', 'comic'],
    // Organic
    ['forest', 'Forest', 'dark', 'Organic', '#17201b #2f5d3a #3f7d4e #4b5d43 #a16207 #4d7c0f #15803d', 'humanist', 'leaves', 'leaf', 'solid', 'organic', 'top'],
    ['moss', 'Moss', 'dark', 'Organic', '#2d353b #3d484d #a7c080 #475258 #dbbc7f #83c092 #7fbbb3', 'humanist', 'topo', 'sprout', 'gradient', 'organic'],
    ['rosewood', 'Rosewood', 'dark', 'Organic', '#191724 #26233a #ebbcba #2a273f #c4a7e7 #9ccfd8 #31748f', 'elegant', 'petals', 'flower', 'gradient', 'glass', 'both'],
    ['sage', 'Sage', 'light', 'Organic', '#fdf6e3 #6c8a24 #8da101 #efebd4 #df69ba #35a77c #3a94c5', 'humanist', 'leaves', 'leaf', 'solid', 'organic'],
    ['rose-dawn', 'Rose Dawn', 'light', 'Organic', '#faf4ed #907aa9 #d7827e #f2e9e1 #b4637a #56949f #286983', 'elegant', 'petals', 'flower', 'solid', 'paper', 'top'],
    ['meadow', 'Meadow', 'light', 'Organic', '#f6faef #3f6212 #65a30d #e3eed3 #c2410c #0f766e #4d7c0f', 'rounded', 'hatch', 'sprout', 'solid', 'organic'],
    // Electric
    ['neon', 'Neon', 'dark', 'Electric', '#262335 #241b2f #ff7edb #34294f #36f9f6 #72f1b8 #fe4450', 'tech', 'grid', 'bolt', 'glow', 'neon', 'bottom'],
    ['cyber', 'Cyber', 'dark', 'Electric', '#0d0221 #261447 #f706cf #2e2157 #00f0ff #00ff9f #fd1d53', 'mono', 'circuit', 'chip', 'glow', 'angled', 'top'],
    ['voltage', 'Voltage', 'dark', 'Electric', '#101418 #1c2128 #f5d000 #2a3038 #00e5ff #7cff4f #ff5e00', 'poster', 'stripes', 'bolt', 'solid', 'ruled'],
    ['highlighter', 'Highlighter', 'light', 'Electric', '#fffdf0 #e6007a #0077ff #fff3b0 #9b00e8 #00a86b #ff4500', 'hand', 'ruled', 'marker', 'highlight', 'sketch'],
    ['circuit', 'Circuit', 'light', 'Electric', '#f0fff7 #00664f #00a37a #d4f5e6 #ff2e88 #0077b6 #00875f', 'mono', 'circuit', 'chip', 'solid', 'dashed'],
    ['pop-art', 'Pop Art', 'light', 'Electric', '#fffef5 #1d1d1d #ff1f5a #ffe45e #2b59c3 #00a676 #ff6f00', 'poster', 'halftone', 'burst', 'shadow', 'comic'],
    // Earth
    ['gravel', 'Gravel', 'dark', 'Earth', '#282828 #3c3836 #d79921 #504945 #b16286 #98971a #458588', 'slab', 'noise', 'mountain', 'solid', 'carved'],
    ['clay', 'Clay', 'dark', 'Earth', '#2a201b #4a2f24 #c96f3b #4a3a31 #7f9c6b #b58a3a #a4532c', 'slab', 'noise', 'tile', 'solid', 'carved', 'top'],
    ['espresso', 'Espresso', 'dark', 'Earth', '#1f1712 #3b2a20 #c8a27a #3a2c23 #8c6a9b #7a9a65 #a0703f', 'elegant', 'grain', 'bean', 'gradient', 'card'],
    ['paper', 'Paper', 'light', 'Earth', '#f6f1e7 #7a4b2a #8a4b2f #e8dfcf #44606f #2f6b4f #6b4226', 'serif', 'noise', 'quill', 'solid', 'paper'],
    ['sand', 'Sand', 'light', 'Earth', '#fbf1c7 #7c6f64 #b57614 #ebdbb2 #8f3f71 #79740e #076678', 'humanist', 'dunes', 'sun', 'solid', 'card', 'top'],
    ['terracotta', 'Terracotta', 'light', 'Earth', '#fbf3ee #9a3412 #c2410c #f3dfd3 #4d6a52 #a16207 #7c2d12', 'slab', 'tiles', 'tile', 'solid', 'carved'],
    // Sky
    ['twilight', 'Twilight', 'dark', 'Sky', '#1a1b26 #24283b #7aa2f7 #292e42 #bb9af7 #9ece6a #2ac3de', 'geometric', 'stars', 'moon', 'gradient', 'glass', 'both'],
    ['storm', 'Storm', 'dark', 'Sky', '#24283b #1f2335 #7dcfff #3b4261 #ff9e64 #73daca #3d59a1', 'tech', 'rain', 'stormcloud', 'solid', 'ruled', 'top'],
    ['aurora', 'Aurora', 'dark', 'Sky', '#2e3440 #3b4252 #88c0d0 #434c5e #b48ead #a3be8c #5e81ac', 'humanist', 'waves', 'wave', 'gradient', 'glass', 'both'],
    ['sky', 'Sky', 'light', 'Sky', '#eef5fb #0e7490 #0369a1 #d6e6f3 #7c3aed #047857 #0284c7', 'rounded', 'bubbles', 'cloud', 'solid', 'pill', 'both'],
    ['dawn', 'Dawn', 'light', 'Sky', '#fff8f2 #c2410c #e76f51 #fde8da #6d5bd0 #2a9d8f #f4a261', 'elegant', 'dunes', 'sun', 'gradient', 'card', 'top'],
    ['cirrus', 'Cirrus', 'light', 'Sky', '#f5f8fc #4c6a92 #3d7bd9 #e2e9f3 #8e5bd6 #2f9e7a #5a8fd8', 'humanist', 'waves', 'feather', 'solid', 'glass', 'top'],
    // Space
    ['midnight', 'Midnight', 'dark', 'Space', '#0f1724 #1f3a5f #2563eb #334155 #7c3aed #0d9488 #0369a1', 'geometric', 'stars', 'planet', 'gradient', 'glass', 'both'],
    ['nebula', 'Nebula', 'dark', 'Space', '#292d3e #1f2233 #c792ea #34394f #82aaff #c3e88d #f07178', 'geometric', 'stars', 'sparkle', 'gradient', 'glass', 'both'],
    ['owl', 'Night Owl', 'dark', 'Space', '#011627 #0b2942 #7fdbca #1d3b53 #c792ea #addb67 #82aaff', 'rounded', 'stars', 'moon', 'solid', 'card', 'top'],
    ['stardust', 'Stardust', 'light', 'Space', '#f5f3ff #4c1d95 #6d28d9 #e4defc #db2777 #059669 #4f46e5', 'geometric', 'stars', 'sparkle', 'gradient', 'card', 'both'],
    ['lunar', 'Lunar', 'light', 'Space', '#f4f5f7 #3b4252 #5e81ac #e5e9f0 #b48ead #4c8a5f #4c566a', 'tech', 'craters', 'moon', 'solid', 'carved'],
    ['comet', 'Comet', 'light', 'Space', '#f7f9fd #1e3a8a #2563eb #e0e7ff #f97316 #0d9488 #1d4ed8', 'geometric', 'streaks', 'comet', 'gradient', 'angled', 'top'],
    // Ocean
    ['deep-sea', 'Deep Sea', 'dark', 'Ocean', '#0f1e2e #123a52 #2ec4b6 #1d3447 #ff9f1c #3bceac #1f6f8b', 'humanist', 'waves', 'drop', 'gradient', 'glass', 'bottom'],
    ['abyss', 'Abyss', 'dark', 'Ocean', '#000c18 #082050 #6688cc #0b2a4a #9966b8 #22aa44 #225588', 'geometric', 'bubbles', 'drop', 'glow', 'glass', 'bottom'],
    ['reef', 'Reef', 'dark', 'Ocean', '#132a2e #1c4247 #ff8a65 #24474c #4dd0e1 #81c784 #00897b', 'rounded', 'hex', 'shell', 'gradient', 'organic'],
    ['seafoam', 'Seafoam', 'light', 'Ocean', '#f0faf8 #0f766e #14b8a6 #d5f0eb #e76f51 #2a9d8f #0d9488', 'rounded', 'waves', 'wave', 'solid', 'pill', 'top'],
    ['coral', 'Coral', 'light', 'Ocean', '#fff5f3 #c2410c #ff6f61 #ffe0da #006d77 #2a9d8f #e85d4a', 'humanist', 'bubbles', 'shell', 'solid', 'organic'],
    ['lagoon', 'Lagoon', 'light', 'Ocean', '#effafc #0e7490 #0891b2 #d3eef4 #7c3aed #059669 #0369a1', 'humanist', 'waves', 'drop', 'gradient', 'card', 'both'],
];

const COLOR_NAMES = ['background', 'title', 'primary', 'secondary', 'tertiary', 'active', 'button'];
const WHITE = [255, 255, 255];
const BLACK = [16, 16, 16];

function rgb(value) {
    const h = value.replace('#', '');
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
function hex(color) {
    return `#${color.map(c => c.toString(16).padStart(2, '0')).join('')}`;
}
function luminance(color) {
    const [r, g, b] = color.map(c => c / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}
/** A color at a percentage over transparent. */
function mix(color, percent) {
    return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}
/** The text color for a color: white or black, whichever reads better. */
function offset(color) {
    const c = rgb(color);
    return contrast(c, WHITE) >= contrast(c, BLACK) ? 'var(--color-white)' : 'var(--color-black)';
}
/** An SVG as an image address for CSS and HTML attributes. */
function svgUrl(svg) {
    return `data:image/svg+xml,${svg.replace(/"/g, "'").replace(/%/g, '%25').replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E')}`;
}

/** What a theme draws with, worked out from its colors: readable accents for headings, and its ink. */
function concept(theme) {
    const [, , scheme, , colorList] = theme;
    const colors = colorList.split(' ');
    const background = rgb(colors[0]);
    const dark = scheme === 'dark';
    // Heading accents are the theme's colors that read well on its background, so a heading is never faint.
    const readable = [colors[2], colors[4], colors[6], colors[5], colors[1]].filter(c => contrast(rgb(c), background) >= 3);
    const fallback = dark ? '#ffffff' : '#1a1a1a';
    const a = readable[0] || fallback;
    const b = readable.find(c => c !== a) || a;
    const c = readable.find(x => x !== a && x !== b) || colors[3];
    const title = rgb(colors[1]);
    const ink = dark ? WHITE : (contrast(title, background) >= 4.5 ? title : [26, 26, 26]);
    return { colors, background, dark, a, b, c, ink: hex(ink), inkRgb: ink };
}

function themeCss(theme) {
    const [value, name, scheme, , , font, texture, mark, heading, segment, glows] = theme;
    const { colors, dark, a, b, c, ink, inkRgb } = concept(theme);
    const root = `:root[data-theme="${value}"]`;
    const strength = dark ? 0.045 : 0.06;
    const textureUrl = svgUrl(TEXTURES[texture](inkRgb, strength, [colors[2], colors[4], colors[5], colors[6]]));
    const lights = [];
    if (glows === 'top' || glows === 'both') lights.push(`radial-gradient(1000px 560px at 88% -8%, ${mix(a, dark ? 18 : 14)}, transparent 62%)`);
    if (glows === 'bottom' || glows === 'both') lights.push(`radial-gradient(900px 520px at -10% 108%, ${mix(b, dark ? 13 : 11)}, transparent 60%)`);
    const vars = [`    color-scheme: ${scheme};`];
    COLOR_NAMES.forEach((key, i) => vars.push(`    --color-${key}: ${colors[i]};`, `    --color-${key}-offset: ${offset(colors[i])};`));
    vars.push(`    --font-family-display: ${FONTS[font]};`);
    if (CAPS.has(font)) vars.push('    --heading-transform: uppercase;', '    --heading-spacing: 0.06em;');
    const headingVars = HEADINGS[heading]({ a, b, ink });
    Object.entries(headingVars).forEach(([key, val]) => vars.push(`    --heading-${key}: ${val};`));
    vars.push(
        // The page title and other headings take the first accent; section headings draw it their own way.
        `    --color-heading: ${a};`,
        `    --heading-rule: ${mix(a, 35)};`,
        `    --heading-mark: url("${svgUrl(MARKS[mark](a, b, c))}");`,
        '    --heading-mark-content: "";',
    );
    Object.entries(SEGMENTS[segment]({ ink, a, b, dark })).forEach(([key, val]) => vars.push(`    --segment-${key}: ${val};`));
    const rules = [
        `/* ${name}: ${font} headings, a ${texture} texture, a ${mark} mark, ${heading} headings and ${segment} segments. */`,
        `${root} {\n${vars.join('\n')}\n}`,
        `${root} webui-app {\n    background-color: var(--color-background);\n    background-image:\n        ${[...lights, `url("${textureUrl}")`].join(',\n        ')};\n}`,
    ];
    return rules.join('\n');
}

function themeOption(theme) {
    const [value, name, scheme, category, colors, font, texture, mark] = theme;
    const attrs = [`value="${value}"`, `data-scheme="${scheme}"`, `data-category="${category}"`, `data-colors="${colors}"`];
    if (font) {
        const { dark, a, b, c, inkRgb } = concept(theme);
        const all = colors.split(' ');
        attrs.push(
            `data-font="${FONTS[font].replace(/"/g, "'")}"`,
            // The tile's texture is drawn stronger, as it is far smaller than a page.
            `data-texture="${svgUrl(TEXTURES[texture](inkRgb, dark ? 0.1 : 0.12, [all[2], all[4], all[5], all[6]]))}"`,
            `data-mark="${svgUrl(MARKS[mark](a, b, c))}"`,
        );
    }
    return `                <option ${attrs.join(' ')}>${name}</option>`;
}

function replaceBetween(text, start, end, body, file) {
    const from = text.indexOf(start);
    const to = text.indexOf(end);
    if (from < 0 || to < from) throw new Error(`${file} needs the markers ${start} and ${end}`);
    return text.slice(0, from + start.length) + `\n${body}\n` + text.slice(to);
}

const cssFile = join(ROOT, 'css', 'app.css');
const css = THEMES.filter(theme => theme[0]).map(themeCss).join('\n\n');
writeFileSync(cssFile, replaceBetween(readFileSync(cssFile, 'utf8'), '/* THEMES:START (tools/themes/build-themes.mjs) */', '/* THEMES:END */', css, cssFile));
const htmlFile = join(ROOT, 'index.html');
const options = THEMES.map(themeOption).join('\n');
writeFileSync(htmlFile, replaceBetween(readFileSync(htmlFile, 'utf8'), '<!-- THEMES:START (tools/themes/build-themes.mjs) -->', '                <!-- THEMES:END -->', options, htmlFile));
console.log(`Built ${THEMES.length} themes.`);
