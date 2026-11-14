// The one markdown dialect: CommonMark + GFM tables, strikethrough and autolinks; a line break is a line break
// (as the Parachute surface renders today). HTML is *parsed* so <details> can be found; the kit never renders it as
// HTML. These are the options the contract's check uses (html, breaks), plus linkify for GFM autolinks.
import markdownit from '../vendor/markdown-it.mjs';

export const md = markdownit({ html: true, breaks: true, linkify: true, typographer: false });
// GFM autolinks only: no fuzzy "example.com" links and no bare e-mail links without mailto:
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
