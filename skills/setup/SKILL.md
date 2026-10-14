---
name: setup
description: "First-run setup for Templated: check the connected account's templates, offer to design one from a short brief when there are none, and produce the user's first render. Use when the user runs setup for Templated, has just connected it, or asks how to get started with Templated."
---

# Get started with Templated

Goal: by the end of this conversation the user has a finished design rendered
from a template and knows how to make the next one.

If the plugin was installed in the middle of another task, continue that task
first and use these steps only where they help.

1. **Check the account.** Call `list_templates` with `limit` set to 10.
   Sign-in is handled by the plugin connection. If a tool reports an
   authorization error, ask the user to reconnect Templated. Never ask for a
   password or an API key.
2. **If the account has templates:** show up to five by name and size, say in
   one short line what each could be used for (based on its name), and ask
   which one to fill or what they want to make.
3. **If the account has no templates:** explain in one sentence that Templated
   fills a saved design with new text and images and returns a PNG, JPG, PDF
   or MP4. Then offer three starting points and ask for the text to use:
   - an Instagram post (1080x1080) for an announcement or event
   - certificates for a list of names, combined into one PDF
   - a link preview image (1200x630) for a blog post or page

   Any other idea is welcome too.
4. **Make the first render.**
   - Existing template: call `get_template_layers`, then `create_render` with
     the user's content in the matching layers.
   - New template: follow the `templated-design` skill to create it with
     `create_template`, then render it with `create_render`.
   - Certificates or other lists: render the first item, show it, and render
     the rest after the user confirms. Then offer to merge them with
     `merge_renders`.

   Keep questions to a minimum. If the user gave a topic but no exact wording,
   write short copy from the topic and say it can be changed.
5. **Show the result and iterate once.** Share the render (the preview card or
   the file URL) and ask for one change. Apply it and render again.
6. **Close with next steps in two or three sentences.** They can ask for this
   again at any time by mentioning Templated. The same template can produce
   many versions, for example one per name in a list or a new post every week.
   The template can be fine-tuned in the Templated editor at app.templated.io.
   Don't mention plans, pricing or upgrades.
