---
name: video-images
description: "Find, add, credit or remove the images in a video: product assets, diagrams and Unsplash photography with its credits. Use when a scene needs a picture, a photo changes, or the credits page must be checked."
---

# Images

## Sources

- **Product assets.** Logos, client logos, product screenshots and wordmarks come from the project's own website or product repositories, as the project's instructions name them. Copy them into the video project's `assets/`. Never change the source repository from a video project.
- **Diagrams.** Use the project's diagram tool, or the `diagram-design` skill. Keep diagrams as files in the project.
- **Essay or article imagery.** Use the header image of the published piece the scene cites. Keep the piece's source text in the project (for example `research/`), so the claims can be checked.
- **Photography.** Photos come from Unsplash, through an Unsplash tool if your harness has one, or through the Unsplash API with `UNSPLASH_ACCESS_KEY` from the environment. Never print the key or ask for it in chat.
  - Before you download a photo, call the photo's `download_location` endpoint. Unsplash's API terms require it.
  - Download at `w=2400`.
  - Save as `assets/photos/u-<photo id>.jpg`.

## Choosing photography

The video type decides how much photography to use (see `video-types`). How-to videos rarely need any. Use the places and settings the project's instructions name for its audience.

Look for:
- Real places that the audience knows.
- Modern workplaces.
- Calm, confident light.

Avoid:
- AI clichés: glowing brains, robots, blue binary code.
- Staged handshakes.
- Readable third-party text and recognisable faces in close-up.

Prefer photos with clear space for text. Check that the photo still reads under the gradient shade the scene applies.

## Branding

If `.neil-dev.json` at the project root (`git rev-parse --show-toplevel`) has `branding`, read `branding.guide` (or else `branding.site`). Take the logos and wordmark from the source it names, and follow its rules on photography and logo use. Otherwise skip this section.

## Credits

Every photo needs all three steps:

1. Add a row to `assets/photos/CREDITS.md` with the file, the photographer and the photo's Unsplash page.
2. Name the photographer on the credits page (`#credits` in the page). Keep each name on one line, for example in `<span class="nm">`.
3. When you remove a photo, delete the file, its row and its name on the credits page.

Never use a photo without a recorded photographer.
