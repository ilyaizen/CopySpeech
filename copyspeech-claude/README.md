# CopySpeech for Claude Code

Reads Claude's replies aloud through the running CopySpeech app. It shows play buttons on every reply and marks the spoken word in a captions pane. It works in the Claude desktop app and in the terminal.

## Install

CopySpeech must run, with its control server on `http://127.0.0.1:43117`.

At the prompt of a terminal session:

```
/plugin install copyspeech --marketplace ilyaizen/CopySpeech
```

From a shell:

```
claude plugin install copyspeech --marketplace ilyaizen/CopySpeech
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `ilyaizen/CopySpeech`, then **Add plugin**.

## Play a reply

In the desktop app, hover a paragraph or list item and click the **▶** at its top right. It reads only that part, in full, whatever the trim settings. To read a whole answer, click **▶** in the captions pane's header, or select the text and pick **Read aloud with CopySpeech**. In the terminal, hover a reply and click **▶ Read** at its bottom right corner. It reads the whole reply, and the trim settings below change what it speaks. While CopySpeech reads, a row above the prompt shows **Pause** (or **Resume**) and **Stop** for that reading, and the captions pane shows the same two buttons at its top. **Stop** and `/copyspeech-stop` stop CopySpeech as its tray's **Stop reading** does: they also cancel every queued and running synthesis, not only this reply's. Inline `code` is read, without its backticks. A dot between names in it is read as "dot": `export.ts` is read as export dot ts. Fenced code blocks and link targets are not read.

## Read a selection

In the desktop app, select text inside a reply, right-click, and choose **Read aloud with CopySpeech**. CopySpeech reads only the selected words. The terminal has no right-click menu. Needs Claude Code 2.1.326 or later.

## Reader pane

Open it with `/copyspeech-settings`, or let a reading open it. Close it with its close button. Run the command again to reopen it. It shows only the latest reading.

- **▶** (play) – reads the last finished answer, or the replies the pane shows. While a reading plays, **Pause** (or **Resume**) and **Stop** replace it.
- **Captions** – draws the reading's replies and marks the spoken word.
- **Read one paragraph or list item** – hover it and press its **▶** button. It reads that part in full.
- **Settings ▸** – expands the settings. A change applies at once.
- **Excerpt controls** – Part, Top and Bottom show only while **Excerpt** is on. Top and Bottom use **-** and **+**, from 1 to 20.

## Settings

Change the settings in one of four ways:

- **Terminal:** run `claude`, type `/config`, and find the CopySpeech rows. A change applies at once.
- **Any surface, auto-read only:** type `/copyspeech-autoread`. It turns **Read new replies aloud** on or off and saves it, as `/config` does.
- **Desktop app:** type `/copyspeech-settings`. It opens the captions pane, and the settings sit in its header row behind **Settings ▸**. Each change saves, as `/config` does, and applies at once.
- **By file:** the Code tab has no settings screen for plugin options. Add a `pluginConfigs` block to `~/.claude/settings.json`:

```json
"pluginConfigs": {
  "copyspeech": {
    "options": {
      "autoRead": false,
      "skipSections": true,
      "excerpt": true,
      "excerptMode": "both",
      "excerptTop": 2,
      "excerptBottom": 2,
      "captions": true
    }
  }
}
```

The key is the plugin's name as Claude Code loaded it: `copyspeech` or `copyspeech@inline` for a folder loaded with `--plugin-dir`, else the installed plugin's name. A setting you leave out keeps its default.

- **Read new replies aloud** – off by default. Reads the finished turn's last text block, the answer. Narration between tool calls is not read.
- **Skip bullet points and sections** – on by default. Automatic and play-button reads skip headings, bullet and numbered items, horizontal rules, and table rows. The text under a heading still reads. A reply made only of those lines reads nothing.
- **Read only part of the reply** – on by default. Automatic and play-button reads keep the top and bottom paragraphs.
- **Part to read** – both (default), top, or bottom. Shown only while **Read only part of the reply** is on.
- **Top paragraphs** and **Bottom paragraphs** – 1 to 20, 2 by default. Each has **-** and **+** buttons in the captions pane's settings, shown only while **Read only part of the reply** is on. A press at 1 or 20 changes nothing. The desktop app's settings list omits these two number rows, so the pane writes them without a listed row. If the engine refuses a write, a toast gives the reason; `/config` or the settings file still sets them.
- **Show captions** – on by default. Opens the captions pane by itself when a reading starts. An open pane still marks the spoken word.

Selection reads always read in full.

## Captions

- Reads CopySpeech's `GET /status` every 120 ms while a reading plays.
- Matches the caption words to the spoken text, which leaves out skipped lines and an excerpt gap: half the words of a caption fragment must match. Across an excerpt gap, it needs a run of 3 words to jump. A one-word fragment matches only a word just after the last match.
- Opens a **CopySpeech Reader** pane when a reading starts, or with `/copyspeech-settings`, only while CopySpeech runs. With CopySpeech down, the pane stays shut, an open pane closes within 5 seconds, and `/copyspeech-settings` says so. The pane stays open after a reading. It shows only the latest reading: a new reading replaces it. Hover a paragraph or a list item to show a **▶** button at its side: it reads only that paragraph or item, in full, whatever the trim settings. A block of only code or rules has no **▶** button.
- The pane's header row holds the colored CopySpeech mark and its name, then the playbox. While nothing plays, the playbox is a plain **▶** play mark, which reads the last finished turn's answer, as auto-read does, else the replies the pane shows. While a reading plays, the name reads **CopySpeech Reading**, with **Pause** (or **Resume**) and **Stop**, as the band above the prompt does. **Settings ▸** sits in the same row; expand it to change a setting, and its body opens under the row. The header scrolls with the pane, so a long reply can move it out of view.
- Draws the reading's replies in the pane block by block, as the transcript draws them. The block that holds the spoken word is drawn by the pane, with a chip on the word in reverse video: the text color behind it, with the background color over it. While the chip is in a block, that block's spacing can differ a little from the others. The pane's own drawing covers headings (larger for `#` and `##`), bullet and numbered lists with hanging indents, quotes, rules, tables as columns, and bold, italic, strikethrough, inline code and links (underlined; the target is dropped). A list is drawn line by line, so each item has its own **▶** button, which speaks that item even while **Skip bullet points and sections** is on. A table has no per-cell button. Fenced code blocks use Claude Code's code view and get no chip, since they are not read. That block also covers `_italic_`, `__bold__` and backslash escapes; a lone `*` stays text. It drops HTML tags (`<br>` becomes a space) and does not draw nested blocks or images.
- Scrolls the pane to center the paragraph that holds the spoken word. A paragraph taller than the pane shows its top.
- The desktop app docks the pane beside the chat. The terminal docks it beside a fullscreen transcript from 110 columns, else shows it above the prompt. With **Read new replies aloud** on, submitting a prompt opens the pane, so each auto-read fills it at any width. An auto-read that opens the pane at turn end waits for 144 columns.
- Holds the last word between words.
- Stops as soon as the app reports the reading ended, or after 60 s with no playback. A stall while synthesis catches up does not stop it.

## Limits

- Claude Code has no hook for the desktop app's selection bar ("Start in a side chat", "Reply", "Dictate"). **Read aloud with CopySpeech** stays in the right-click menu.
- Indented code blocks are read: Claude Code replies use indentation for nested lists too.
- The transcript does not scroll by itself to follow the spoken word. The captions pane does.
- A reading that CopySpeech runs for other text shows no chip.

## Develop

Load the folder for one session with `claude --plugin-dir copyspeech-claude`, or name it in `CLAUDE_CODE_PLUGIN_DIRS`. Then run the commands below with the same Claude Code version that runs the session. Version 2.1.319 has no right-click menu, so it warns that the `ContextMenu` hook never runs and the menu tests fail:

```
claude plugin validate copyspeech-claude
claude plugin test copyspeech-claude
```
