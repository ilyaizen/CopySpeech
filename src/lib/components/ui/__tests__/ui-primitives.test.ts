// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { get } from "svelte/store";
import { setLocale, waitForI18nReady } from "#lib/i18n";
import { isRtl } from "#lib/i18n/store";
import InfoTooltip from "../info-tooltip.svelte";
import Slider from "../slider/slider.svelte";

beforeAll(async () => {
  await waitForI18nReady();
});

afterEach(() => {
  cleanup();
  setLocale("en");
  vi.unstubAllGlobals();
});

describe("Slider", () => {
  it("fires oninput and onchange with snapped values", async () => {
    const oninput = vi.fn();
    const onchange = vi.fn();
    const { container } = render(Slider, {
      value: 1,
      min: 0.5,
      max: 2,
      step: 0.05,
      oninput,
      onchange
    });

    const input = container.querySelector('input[type="range"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing slider input");

    input.value = "1.234";
    await fireEvent.input(input);
    expect(oninput).toHaveBeenCalledWith(1.25);

    input.value = "1.789";
    await fireEvent.input(input);
    await fireEvent.change(input);
    expect(onchange).toHaveBeenCalledWith(1.8);
  });
});

describe("InfoTooltip", () => {
  it("renders the floating tooltip in the current RTL locale", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    setLocale("he");
    await waitForI18nReady();
    await waitFor(() => expect(get(isRtl)).toBe(true));
    render(InfoTooltip, { text: "הפעל את CopySpeech כשאתה מתחבר" });
    await fireEvent.focus(screen.getByRole("button"));
    const text = await screen.findByText("הפעל את CopySpeech כשאתה מתחבר");
    const wrapper = text.closest("[data-bits-floating-content-wrapper]");
    expect(wrapper?.getAttribute("dir")).toBe("rtl");
    setLocale("en");
    await waitFor(() => expect(wrapper?.getAttribute("dir")).toBe("ltr"));
  });
});
