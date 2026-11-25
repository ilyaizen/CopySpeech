import { Button, Input, SegmentedControl, ToggleRow, useQuery, useValue } from "@hermes/plugin-sdk";
import { useEffect, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { EXCERPT_MAX, EXCERPT_MIN, ID } from "../constants.js";
import {
  applyEdit,
  builtInAutoSpeakOn,
  draftView,
  pendingEdits,
  readSettings,
  saveSettings
} from "../settings.js";
import { probeCopySpeech } from "../transport.js";

// Edits stay in local state until Save. Cancel clears them.
export function SettingsPage({ storage, settings }) {
  const saved = useValue(settings);
  const [changes, setChanges] = useState({});
  useEffect(() => {
    // A saved change (palette toggle, storage event) can make an edit equal. Drop it so it cannot return.
    setChanges((draft) => {
      const kept = pendingEdits(saved, draft);
      return Object.keys(kept).length === Object.keys(draft).length ? draft : kept;
    });
  }, [saved]);
  const s = draftView(saved, changes);
  const dirty = Object.keys(pendingEdits(saved, changes)).length > 0;
  const health = useQuery({
    queryKey: [ID, "health"],
    queryFn: probeCopySpeech,
    refetchInterval: 10000
  });
  const update = (patch) => setChanges((draft) => applyEdit(settings.get(), draft, patch));
  const save = () => {
    // Compare with stored settings, not this window's copy: another window may have saved since.
    saveSettings(storage, settings, pendingEdits(readSettings(storage), changes));
    setChanges({});
  };
  const cancel = () => setChanges({});
  const builtIn = builtInAutoSpeakOn();
  const status =
    health.data === undefined
      ? "Checking CopySpeech…"
      : health.data
        ? "CopySpeech is running"
        : "CopySpeech not reachable on 127.0.0.1:43117";
  const showTop = s.excerptMode !== "bottom";
  const showBottom = s.excerptMode !== "top";

  return jsxs("div", {
    className: "flex flex-col gap-3 p-3 text-sm",
    children: [
      jsx("div", { className: "text-(--ui-text-secondary)", children: status }),
      jsx(ToggleRow, {
        label: "Read new replies aloud",
        checked: s.autoRead,
        onChange: (on) => update({ autoRead: on })
      }),
      builtIn
        ? jsx("div", {
            className: "text-(--ui-text-tertiary)",
            children:
              'Hermes\u2019s own "Read replies aloud" is on. Turn it off to avoid double playback.'
          })
        : null,
      jsx(ToggleRow, {
        label: "Highlight spoken words",
        checked: s.captions,
        onChange: (on) => update({ captions: on })
      }),
      s.captions
        ? jsx(ToggleRow, {
            label: "Glide between words",
            checked: s.glide,
            onChange: (on) => update({ glide: on })
          })
        : null,
      jsx(ToggleRow, {
        label: "Follow playback",
        checked: s.follow,
        onChange: (on) => update({ follow: on })
      }),
      jsx(ToggleRow, {
        label: "Show play buttons on replies",
        checked: s.messageButtons,
        onChange: (on) => update({ messageButtons: on })
      }),
      jsx(ToggleRow, {
        label: "Read aloud on selection",
        checked: s.selectionRead,
        onChange: (on) => update({ selectionRead: on })
      }),
      jsx(ToggleRow, {
        label: "Skip bullet points and sections",
        checked: s.skipMarkdownSections,
        onChange: (on) => update({ skipMarkdownSections: on })
      }),
      jsx(ToggleRow, {
        label: "Read only part of the reply",
        checked: s.excerpt,
        onChange: (on) => update({ excerpt: on })
      }),
      s.excerpt
        ? jsx(SegmentedControl, {
            options: [
              { id: "top", label: "Top" },
              { id: "bottom", label: "Bottom" },
              { id: "both", label: "Top and bottom" }
            ],
            value: s.excerptMode,
            onChange: (id) => update({ excerptMode: id })
          })
        : null,
      s.excerpt && showTop
        ? jsxs("div", {
            className: "flex items-center justify-between gap-3",
            children: [
              jsx("span", { children: "Top paragraphs" }),
              jsx(Input, {
                type: "number",
                min: EXCERPT_MIN,
                max: EXCERPT_MAX,
                value: s.excerptTop,
                onChange: (e) => update({ excerptTop: Number(e.target.value) })
              })
            ]
          })
        : null,
      s.excerpt && showBottom
        ? jsxs("div", {
            className: "flex items-center justify-between gap-3",
            children: [
              jsx("span", { children: "Bottom paragraphs" }),
              jsx(Input, {
                type: "number",
                min: EXCERPT_MIN,
                max: EXCERPT_MAX,
                value: s.excerptBottom,
                onChange: (e) => update({ excerptBottom: Number(e.target.value) })
              })
            ]
          })
        : null,
      dirty
        ? jsxs("div", {
            className: "flex items-center justify-end gap-2",
            children: [
              jsx("span", {
                className: "me-auto text-(--ui-text-tertiary)",
                children: "Unsaved changes"
              }),
              jsx(Button, { variant: "outline", size: "sm", onClick: cancel, children: "Cancel" }),
              jsx(Button, { size: "sm", onClick: save, children: "Save" })
            ]
          })
        : null
    ]
  });
}
