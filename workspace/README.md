# JSU Marketing Website

This is a static, multi-page marketing website for JSU Marketing, a digital agency specializing in affordable, high-quality digital marketing tailored to small businesses.

## Features

- Clean, modern responsive design using Tailwind CSS (CDN)
- Five fully static pages: Home, Services, Team, Projects, Contact
- All copy and details match the agency's authentic facts, services, team, and clients
- Fully accessible, semantic markup
- Only verified names/metrics/testimonials, no invented content
- Hamburger menu (minimal JS) for mobile nav

## How to Use

1. Download/extract all files.
2. Open `index.html` (or any page) in your browser.
3. Edit content as needed for future updates.

---

## File Structure

```
/assets/
  /css/
    tailwind-custom.css
  /img/
README.md
index.html
team.html
services.html
projects.html
contact.html
```

**Note:** No real images included—fallback to monogram avatars and abstract icons as specified.

---

Tailwind is included via CDN. Custom properties and limited CSS utilities are in `/assets/css/tailwind-custom.css`.

---

FILE: assets/css/tailwind-custom.css
:root {
  --color-primary: #2563eb;
  --color-primary-light: #3b82f6;
  --color-secondary: #0f172a;
  --color-bg: #f8fafc;
  --color-surface: #ffffff;
  --color-border: #e5e7eb;
  --color-accent: #f59e42;
}
.bg-primary { background-color: var(--color-primary) !important; }
.bg-primary-light { background-color: var(--color-primary-light) !important; }
.bg-secondary { background-color: var(--color-secondary) !important; }
.bg-bg { background-color: var(--color-bg) !important; }
.bg-surface { background-color: var(--color-surface) !important; }
.text-primary { color: var(--color-primary) !important; }
.text-secondary { color: var(--color-secondary) !important; }
.text-accent { color: var(--color-accent) !important; }
.border-default { border-color: var(--color-border) !important; }

