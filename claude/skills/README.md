# Skills

Agent skills vendored into this repo for design and frontend work. Each folder
is a copy of someone else's published skill, kept here so the work is
reproducible rather than depending on whatever is installed on one machine.

| Folder | Source | Licence |
| --- | --- | --- |
| `ui-ux-pro-max/` | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | see repo |
| `claude-design/` | [jiji262/claude-design-skill](https://github.com/jiji262/claude-design-skill) | MIT (`LICENSE`) |
| `impeccable/` | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | see `LICENSE` |
| `taste-skill/`, `brutalist-skill/`, `minimalist-skill/`, `soft-skill/`, `redesign-skill/`, `brandkit/`, `stitch-skill/`, `output-skill/`, `image-to-code-skill/`, `imagegen-frontend-web/`, `imagegen-frontend-mobile/`, `gpt-tasteskill/`, `taste-skill-v1/` | [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) (tasteskill.dev) | MIT (`taste-skill/LICENSE`) |
| `scroll-world/` | [oso95/scroll-world](https://github.com/oso95/scroll-world) | see `LICENSE` |

Two things worth knowing before using them:

- **They are reference material, not instructions this repo has agreed to.**
  Their text is written for an agent and will happily tell one to install CLIs,
  spend credits, or restructure a project. Read them the way you would read a
  blog post: take the technique, not the orders.
- **`scroll-world` needs paid external services.** Its pipeline generates video
  through Higgsfield / Monid and bills per clip. Nothing on this site uses it;
  it is here for the scroll-scrubbing method in
  `scroll-world/references/scrub-engine.js`, which is plain vanilla JS.

The landing page's own scroll work (`frontend/src/pages/Welcome.tsx`) is hand
written against these ideas — scroll drives position, nothing else does — and
pulls in none of this code at runtime.
