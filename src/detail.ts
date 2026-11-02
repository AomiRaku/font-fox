// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

/** 右侧详情面板：单选详情 / 多选摘要 / 空态。 */

import { icon } from "./icons";
import { languageList, t } from "./i18n";
import { openContextMenu, type MenuItem } from "./contextmenu";
import {
  defaultPreviewText,
  PREVIEW_FONT_SIZE,
  type FontEntry,
  type FontAxis,
  type Settings,
  protectionLabel,
} from "./types";
import type { PreviewPool } from "./preview";
import { el, formatBytes } from "./rows";
import { attachOverlayScrollbar, detachOverlayScrollbar } from "./scrollbar";
import { previewWeight, styleLabel, toHexColor } from "./preview";

/** 详情面板大样字的字号（CSS px） */
const DETAIL_SAMPLE_SIZE = 28;

export interface DetailHandlers {
  toggleDetails(): void;
  toggleHidden(entries: FontEntry[]): void;
  /** 请求删除（单选或多选），由上层弹确认框。 */
  requestDelete(entries: FontEntry[]): void;
  cleanMissing(entry: FontEntry): void;
  exportFonts(entries: FontEntry[]): void;
  reveal(entry: FontEntry): void;
  /** 多选视图：把当前列表里未选中的字体选上、已选中的取消。 */
  invertSelection(): void;
}

export interface DetailContext {
  settings: Settings;
  pool: PreviewPool;
  registryKey: string;
  detailsOpen: boolean;
  isTogglePending: (entries: FontEntry[]) => boolean;
}

/** 详情面板的操作按钮：图标 + 文案。 */
function actionButton(
  iconName: Parameters<typeof icon>[0],
  label: string,
  className = "btn btn--solid",
): HTMLButtonElement {
  const button = el("button", className) as HTMLButtonElement;
  button.type = "button";
  button.appendChild(icon(iconName, "btn__icon"));
  button.appendChild(el("span", "", label));
  return button;
}

/** 只有图标的按钮：文字放进 title / aria-label，形状保持方形。 */
function iconButton(
  iconName: Parameters<typeof icon>[0],
  label: string,
  className = "btn btn--solid btn--icon",
): HTMLButtonElement {
  const button = el("button", className) as HTMLButtonElement;
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.appendChild(icon(iconName, "btn__icon"));
  return button;
}

/** 详情操作区的三点菜单；菜单右边缘与按钮对齐。 */
function actionsMenu(items: MenuItem[]): HTMLButtonElement {
  const button = iconButton("context-menu", t("detail.actionsMenu"), "btn btn--icon detail__menu");
  button.addEventListener("click", () => {
    const rect = button.getBoundingClientRect();
    openContextMenu(items, rect.right, rect.bottom + 4, { alignRight: true });
  });
  return button;
}

/** 字体特性的本地化列表；没有特性时显示「无」。 */
function featureList(entries: FontEntry[]): string {
  const labels = new Set<string>();
  for (const entry of entries) {
    if (entry.monospace) labels.add(t("feature.monospace"));
    if (entry.ligatures) labels.add(t("feature.ligatures"));
    if (entry.hinting) labels.add(t("feature.hinting"));
    if (entry.variable) labels.add(t("feature.variable"));
  }
  return labels.size > 0 ? languageList([...labels]) : t("detail.none");
}
function kv(label: string, value: string, mono = false): HTMLElement {
  const row = el("div", "kv__row");
  row.appendChild(el("div", "kv__k", label));
  row.appendChild(el("div", mono ? "kv__v kv__v--mono" : "kv__v", value || "—"));
  return row;
}

function section(title: string, rows: HTMLElement[]): HTMLElement {
  const box = el("div", "section");
  box.appendChild(el("div", "section__title", title));
  const list = el("div", "kv");
  for (const row of rows) list.appendChild(row);
  box.appendChild(list);
  return box;
}

function statusLine(entry: FontEntry): string {
  if (!entry.exists) return t("detail.statusMissing");
  const bits: string[] = [entry.scope === "system" ? t("detail.scopeSystem") : t("detail.scopeUser")];
  bits.push(entry.hidden ? t("detail.hidden") : t("detail.visible"));
  if (entry.protected) bits.push(t("detail.protected"));
  return bits.join(" · ");
}

/** 样字框：`apply` 用于字重滑块实时重绘。 */
interface SampleView {
  box: HTMLElement;
  apply(axes: Record<string, number>, live: boolean): void;
}

function sample(entry: FontEntry, ctx: DetailContext, stacked = false): SampleView {
  // 切换字体时先释放上一张实时预览图
  ctx.pool.clearLive();

  const box = stacked
    ? el("div", "detail__sample detail__sample--stack")
    : el("div", "detail__sample");
  const text = el("div", "detail__sample-text");
  text.style.fontSize = `${PREVIEW_FONT_SIZE}px`;
  const content = ctx.settings.previewText || defaultPreviewText();
  const allowFallback = !ctx.settings.previewText;
  const noop = { box, apply: () => undefined };

  if (!entry.exists) {
    text.textContent = t("detail.previewMissing");
    text.style.color = "var(--muted)";
    box.appendChild(text);
    return noop;
  }

  if (entry.format === "Raster") {
    text.textContent = t("detail.previewRaster");
    text.style.fontSize = "var(--fs-sm)";
    text.style.color = "var(--muted)";
    box.appendChild(text);
    return noop;
  }

  text.textContent = content;
  box.appendChild(text);
  const color = toHexColor(getComputedStyle(document.body).color);
  let current: HTMLElement = text;
  let available = 0;
  let requestSeq = 0;

  const showPlaceholder = (message: string): void => {
    if (current instanceof HTMLImageElement) {
      const placeholder = el("div", "detail__sample-text", message);
      placeholder.style.fontSize = "var(--fs-sm)";
      placeholder.style.color = "var(--muted)";
      current.replaceWith(placeholder);
      current = placeholder;
      return;
    }
    current.textContent = message;
    current.style.fontSize = "var(--fs-sm)";
    current.style.color = "var(--muted)";
  };

  const paint = (axes: Record<string, number>, live: boolean): void => {
    if (available <= 0) return;
    requestSeq += 1;
    const seq = requestSeq;
    ctx.pool.request(
      {
        entry,
        text: content,
        fontSize: DETAIL_SAMPLE_SIZE,
        color,
        maxWidth: available,
        axes,
        allowFallback,
      },
      (url, noGlyphs) => {
        // 初始请求可能晚于字重滑杆的实时请求返回，只接受最新一次
        if (seq !== requestSeq) return;
        if (noGlyphs) {
          showPlaceholder(t("preview.noChars"));
          return;
        }
        if (!url) {
          showPlaceholder(t("detail.previewFailedFallback"));
          return;
        }
        const image = document.createElement("img");
        image.className = "detail__preview-img";
        image.alt = "";
        image.src = url;
        current.replaceWith(image);
        current = image;
      },
      { live },
    );
  };

  // 等面板挂进 DOM 拿到可用宽度，再按该宽度折行渲染
  requestAnimationFrame(() => {
    const style = getComputedStyle(box);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    available = Math.max(120, box.clientWidth - (Number.isFinite(padding) ? padding : 0));
    paint(previewAxes(entry), false);
  });

  return { box, apply: paint };
}

/** 可变字体的可调轴；旧数据没有 axes 时用 wght 范围兜底。 */
function axesOf(entry: FontEntry): FontAxis[] {
  if (entry.axes?.length) return entry.axes;
  if (entry.variable && entry.weightMax > entry.weightMin) {
    return [{
      tag: "wght",
      min: entry.weightMin,
      max: entry.weightMax,
      default: previewWeight(entry) || entry.weightMin,
    }];
  }
  return [];
}

/** 初始轴值：默认值；wght 优先 Regular 400，不在范围内时取中点。 */
function previewAxes(entry: FontEntry): Record<string, number> {
  const axes = axesOf(entry);
  const values: Record<string, number> = {};
  for (const axis of axes) values[axis.tag] = axis.default;
  const weight = axes.find((axis) => axis.tag === "wght");
  if (weight) values.wght = previewWeight(entry) || weight.default;
  return values;
}

function axisLabel(tag: string): string {
  switch (tag) {
    case "wght":
      return t("detail.weight");
    case "wdth":
      return t("axis.width");
    case "slnt":
      return t("axis.slant");
    case "ital":
      return t("axis.italic");
    case "opsz":
      return t("axis.opticalSize");
    case "GRAD":
      return t("axis.grade");
    default:
      return tag.toUpperCase();
  }
}

function axisStep(axis: FontAxis): number {
  return axis.max - axis.min <= 2 ? 0.1 : 1;
}

function axisText(value: number, step: number): string {
  return step < 1 ? String(Number(value.toFixed(1))) : String(Math.round(value));
}

/** 单个可调轴：拖动实时预览，松手后把最终值写入缓存。 */
function axisControl(
  axis: FontAxis,
  values: Record<string, number>,
  apply: (axes: Record<string, number>, live: boolean) => void,
): HTMLElement {
  const row = el("div", "detail__weight");
  const head = el("div", "detail__weight-head");
  const label = axisLabel(axis.tag);
  head.appendChild(el("span", "detail__weight-label", label));

  const min = axis.min;
  const max = axis.max;
  const step = axisStep(axis);
  let current = values[axis.tag] ?? axis.default;
  let frame = 0;
  let dragging = false;

  const slider = el("div", "detail__slider");
  slider.tabIndex = 0;
  slider.setAttribute("role", "slider");
  slider.setAttribute("aria-label", label);
  slider.setAttribute("aria-valuemin", String(min));
  slider.setAttribute("aria-valuemax", String(max));

  const track = el("div", "detail__slider-track");
  const fill = el("div", "detail__slider-fill");
  const thumb = el("div", "detail__slider-thumb");
  track.append(fill, thumb);
  slider.appendChild(track);

  const value = el("span", "detail__weight-value", axisText(current, step));
  head.appendChild(value);
  row.append(head, slider);

  const round = (next: number): number =>
    Math.max(min, Math.min(max, Math.round((next - min) / step) * step + min));

  const syncView = (): void => {
    const percent = max > min ? ((current - min) / (max - min)) * 100 : 0;
    slider.style.setProperty("--fill", `${percent}%`);
    slider.setAttribute("aria-valuenow", String(current));
  };

  const setValue = (next: number, live: boolean): void => {
    const clamped = round(next);
    if (clamped === current && live) return;
    current = clamped;
    values[axis.tag] = current;
    value.textContent = axisText(current, step);
    syncView();
    if (live) {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        apply({ ...values }, true);
      });
    } else {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      apply({ ...values }, false);
    }
  };

  const setFromPointer = (clientX: number, jump: boolean): void => {
    if (jump) {
      const rect = track.getBoundingClientRect();
      const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      setValue(min + ratio * (max - min), true);
    }
  };

  const startDrag = (event: PointerEvent, jump: boolean): void => {
    event.preventDefault();
    dragging = true;
    slider.classList.add("is-dragging");
    slider.setPointerCapture(event.pointerId);
    setFromPointer(event.clientX, jump);
  };

  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    slider.classList.remove("is-dragging");
    apply({ ...values }, false);
  };

  track.addEventListener("pointerdown", (event) => startDrag(event, true));
  thumb.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    startDrag(event, false);
  });
  slider.addEventListener("pointermove", (event) => {
    if (dragging) setFromPointer(event.clientX, true);
  });
  slider.addEventListener("pointerup", endDrag);
  slider.addEventListener("pointercancel", endDrag);
  slider.addEventListener("lostpointercapture", endDrag);
  slider.addEventListener("keydown", (event) => {
    let next = current;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next -= step;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next += step;
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = max;
        break;
      case "PageDown":
        next -= step * 10;
        break;
      case "PageUp":
        next += step * 10;
        break;
      default:
        return;
    }
    event.preventDefault();
    setValue(next, false);
  });

  current = round(current);
  values[axis.tag] = current;
  value.textContent = axisText(current, step);
  syncView();
  return row;
}

let axesPanel: HTMLElement | null = null;
let axesPanelButton: HTMLButtonElement | null = null;
let axesPanelCleanup: (() => void) | null = null;

function closeAxesPanel(): void {
  if (!axesPanel) return;
  const panel = axesPanel;
  axesPanel = null;
  axesPanelCleanup?.();
  axesPanelCleanup = null;
  detachOverlayScrollbar(panel);
  panel.remove();
  axesPanelButton?.setAttribute("aria-expanded", "false");
  axesPanelButton = null;
}

function openAxesPanel(
  entry: FontEntry,
  anchor: HTMLElement,
  button: HTMLButtonElement,
  apply: (axes: Record<string, number>, live: boolean) => void,
): void {
  closeAxesPanel();
  axesPanelButton = button;
  button.setAttribute("aria-expanded", "true");

  const panel = el("div", "axes-popover");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", t("detail.axes"));

  const head = el("div", "axes-popover__head");
  head.appendChild(el("span", "axes-popover__title", t("detail.axes")));
  const reset = iconButton(
    "reset",
    t("detail.resetAxes"),
    "btn btn--icon axes-popover__reset",
  );
  reset.addEventListener("click", () => {
    apply(previewAxes(entry), false);
    closeAxesPanel();
    openAxesPanel(entry, anchor, button, apply);
  });
  head.appendChild(reset);
  panel.appendChild(head);

  const values = previewAxes(entry);
  for (const axis of axesOf(entry)) {
    panel.appendChild(axisControl(axis, values, apply));
  }
  document.body.appendChild(panel);
  attachOverlayScrollbar(panel);

  const rect = anchor.getBoundingClientRect();
  panel.style.width = `${Math.round(rect.width)}px`;
  panel.style.left = `${Math.max(4, Math.round(rect.left))}px`;
  const top = Math.round(rect.bottom + 4);
  panel.style.top = `${top}px`;
  panel.style.maxHeight = `${Math.min(420, Math.max(120, window.innerHeight - top - 8))}px`;

  const onOutside = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (panel.contains(target) || button.contains(target)) return;
    closeAxesPanel();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeAxesPanel();
    button.focus();
  };
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  axesPanelCleanup = () => {
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  axesPanel = panel;
}

function axesConfigButton(
  entry: FontEntry,
  box: HTMLElement,
  apply: (axes: Record<string, number>, live: boolean) => void,
): HTMLButtonElement {
  const button = iconButton(
    "configuration",
    t("detail.axes"),
    "btn btn--icon detail__sample-config",
  );
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => {
    if (axesPanel && axesPanelButton === button) {
      closeAxesPanel();
    } else {
      openAxesPanel(entry, box, button, apply);
    }
  });
  return button;
}function emptyState(): HTMLElement {
  const empty = el("div", "detail__empty");
  empty.appendChild(
    el("div", "detail__empty-hint", t("list.detailEmptyHint")),
  );
  return empty;
}

function multiPane(
  entries: FontEntry[],
  handlers: DetailHandlers,
  isTogglePending: (entries: FontEntry[]) => boolean,
): DocumentFragment {
  const fragment = document.createDocumentFragment();

  const head = el("div", "detail__head");
  head.appendChild(el("h2", "detail__title", t("detail.multiTitle", { count: entries.length })));
  const sub = el("div", "detail__sub");
  sub.appendChild(el("span", "", t("detail.multiSub")));
  head.appendChild(sub);
  fragment.appendChild(head);


  const actions = el("div", "detail__actions detail__actions--primary");
  const trailing = el("div", "detail__actions-end");

  const userEntries = entries.filter((e) => e.exists && !e.protected);
  if (userEntries.length > 0) {
    const allHidden = userEntries.every((e) => e.hidden);
    const toggle = actionButton(
      allHidden ? "eye-filled" : "eye-cancelled-filled",
      allHidden ? t("ctx.enable") : t("ctx.disable"),
      "btn btn--solid detail__actions-grow",
    );
    toggle.disabled = isTogglePending(userEntries);
    toggle.addEventListener("click", () => handlers.toggleHidden(userEntries));
    actions.appendChild(toggle);
  }

  const deletable = entries.filter((e) => e.exists && !e.protected);
  const exportable = entries.filter((entry) => entry.exists);

  const secondary = el("div", "detail__actions detail__actions--secondary");
  const invert = el("button", "btn btn--solid", t("detail.invertSelection"));
  invert.type = "button";
  invert.addEventListener("click", () => handlers.invertSelection());
  secondary.appendChild(invert);
  fragment.appendChild(secondary);

  const menuItems: MenuItem[] = [];
  if (exportable.length > 0) {
    menuItems.push({
      label: t("detail.exportFont"),
      icon: "export",
      run: () => handlers.exportFonts(exportable),
    });
  }
  menuItems.push({
    label: t("detail.reveal"),
    icon: "folder-open-filled",
    disabled: true,
  });
  if (entries.some((entry) => entry.exists)) {
    menuItems.push({
      label: t("detail.delete"),
      icon: "trashcan-filled",
      danger: deletable.length > 0,
      disabled: deletable.length === 0,
      run: deletable.length > 0 ? () => handlers.requestDelete(deletable) : undefined,
    });
  }
  if (menuItems.some((item) => !item.disabled)) trailing.appendChild(actionsMenu(menuItems));
  actions.appendChild(trailing);
  fragment.appendChild(actions);
  return fragment;
}

export function renderDetail(
  container: HTMLElement,
  entries: FontEntry[],
  ctx: DetailContext,
  handlers: DetailHandlers,
): void {
  closeAxesPanel();
  container.replaceChildren();

  if (entries.length === 0) {
    container.appendChild(emptyState());
    return;
  }

  if (entries.length > 1) {
    container.appendChild(multiPane(entries, handlers, ctx.isTogglePending));
    return;
  }

  const entry = entries[0];
  const head = el("div", "detail__head");
  const titleRow = el("div", "detail__title-row");
  titleRow.appendChild(el("h2", "detail__title", entry.family || entry.displayName));
  if (entry.variable) {
    titleRow.appendChild(el("span", "tag detail__tag", t("detail.variableTag")));
  }
  head.appendChild(titleRow);
  const sub = el("div", "detail__sub");
  const style = styleLabel(entry);
  if (style) sub.appendChild(el("span", "", style));
  head.appendChild(sub);
  container.appendChild(head);

  const sampleView = sample(entry, ctx);
  container.appendChild(sampleView.box);
  if (axesOf(entry).length > 0) {
    sampleView.box.appendChild(axesConfigButton(entry, sampleView.box, sampleView.apply));
  }

  const actions = el("div", "detail__actions");
  const trailing = el("div", "detail__actions-end");

  if (!entry.exists) {
    const clean = el("button", "btn btn--solid btn--danger", t("detail.cleanMissing"));
    clean.type = "button";
    clean.addEventListener("click", () => handlers.cleanMissing(entry));
    actions.appendChild(clean);
  } else if (!entry.protected) {
    const toggle = actionButton(
      entry.hidden ? "eye-filled" : "eye-cancelled-filled",
      entry.hidden ? t("detail.showFont") : t("detail.hideFont"),
      "btn btn--solid",
    );
    toggle.title = entry.hidden
      ? t("detail.hideHintRevert")
      : entry.scope === "system"
    ? t("detail.hideHintUser")
    : t("detail.hideHintSystem");
    toggle.disabled = ctx.isTogglePending([entry]);
    toggle.addEventListener("click", () => handlers.toggleHidden([entry]));
    actions.appendChild(toggle);
  } else {
    // 受保护字体：原「停用」按钮的位置改成一句说明
    actions.appendChild(el("span", "detail__note", t("detail.protectedNote")));
  }

  const menuItems: MenuItem[] = [];
  if (entry.exists) {
    menuItems.push({
      label: t("detail.exportFont"),
      icon: "export",
      run: () => handlers.exportFonts([entry]),
    });
    menuItems.push({
      label: t("detail.reveal"),
      icon: "folder-open-filled",
      run: () => handlers.reveal(entry),
    });
  }
  if (entry.exists) {
    menuItems.push({
      label: t("detail.delete"),
      icon: "trashcan-filled",
      danger: !entry.protected,
      disabled: entry.protected,
      run: entry.protected ? undefined : () => handlers.requestDelete([entry]),
    });
  }
  if (menuItems.length > 0) trailing.appendChild(actionsMenu(menuItems));
  if (trailing.childElementCount > 0) actions.appendChild(trailing);
  container.appendChild(actions);
  // 字体信息在前，文件信息在后；单字体详情不重复列出所属字族
  const fontRows: HTMLElement[] = [];
  fontRows.push(kv(t("detail.fullName"), entry.fullName || entry.displayName));
  // 语言按字形覆盖判定，可能有很多种，全部列出
  // 符号 / 图标字体通常判不出语言，与列表一致显示「未知」
  fontRows.push(
    kv(
      t("detail.language"),
      entry.languages?.length ? languageList(entry.languages) : t("language.unknown"),
    ),
    kv(t("detail.features"), featureList([entry])),
  );
  if (entry.version) fontRows.push(kv(t("detail.version"), entry.version));
  if (entry.copyright) fontRows.push(kv(t("detail.copyright"), entry.copyright));
  // 元信息独立滚动，标题 / 样字 / 操作区保持固定
  const scroll = el("div", "detail__scroll");
  scroll.appendChild(section(t("detail.sectionFont"), fontRows));

  // 文件与注册表等技术细节默认收起，避免详情面板过于“工程化”。
  const moreToggle = el("button", "detail__toggle");
  moreToggle.type = "button";
  moreToggle.setAttribute("aria-expanded", String(ctx.detailsOpen));
  const moreLabel = el(
    "span",
    "",
    ctx.detailsOpen ? t("detail.technicalLess") : t("detail.technicalMore"),
  );
  moreToggle.appendChild(moreLabel);
  moreToggle.appendChild(icon("chevron-down", "detail__chev"));
  scroll.appendChild(moreToggle);

  // 始终渲染详情，靠 grid 行高做展开 / 收起动画；不重建 DOM，滚动位置不会跳回顶部
  const moreBody = el("div", ctx.detailsOpen ? "detail__more is-open" : "detail__more");
  const moreInner = el("div", "detail__more-inner");
  moreInner.appendChild(
    section(t("detail.sectionFile"), [
      kv(t("detail.fileName"), entry.fileName, true),
      kv(t("detail.path"), entry.path, true),
      kv(t("detail.size"), formatBytes(entry.size)),
      kv(t("detail.format"), entry.format),
    ]),
  );
  moreInner.appendChild(
    section(t("detail.sectionRegistry"), [
      kv(t("detail.valueName"), entry.valueName, true),
      kv(t("detail.location"), ctx.registryKey, true),
      kv(t("detail.state"), statusLine(entry)),
    ]),
  );
  moreBody.appendChild(moreInner);
  scroll.appendChild(moreBody);

  moreToggle.addEventListener("click", () => {
    const open = !moreBody.classList.contains("is-open");
    moreBody.classList.toggle("is-open", open);
    moreToggle.setAttribute("aria-expanded", String(open));
    moreLabel.textContent = t(open ? "detail.technicalLess" : "detail.technicalMore");
    handlers.toggleDetails();
  });
  container.appendChild(scroll);
}
/** 字族详情：以一个「整体」呈现，没有具体文件信息。 */
export function renderFamilyDetail(
  container: HTMLElement,
  family: string,
  entries: FontEntry[],
  ctx: DetailContext,
  handlers: DetailHandlers,
): void {
  closeAxesPanel();
  container.replaceChildren();
  if (entries.length === 0) {
    container.appendChild(emptyState());
    return;
  }

  const head = el("div", "detail__head");
  const titleRow = el("div", "detail__title-row");
  titleRow.appendChild(el("h2", "detail__title", family));
  titleRow.appendChild(el("span", "tag detail__tag", t("detail.familyTag")));
  head.appendChild(titleRow);
  const sub = el("div", "detail__sub");
  sub.appendChild(el("span", "", t("detail.styleCount", { count: entries.length })));
  head.appendChild(sub);
  container.appendChild(head);

  // 预览用首个字重，背景加「堆叠」示意——表示这是一个字族而不是单个文件
  const sampleView = sample(entries[0], ctx, true);
  container.appendChild(sampleView.box);
  if (axesOf(entries[0]).length > 0) {
    sampleView.box.appendChild(axesConfigButton(entries[0], sampleView.box, sampleView.apply));
  }

  const actions = el("div", "detail__actions");
  const trailing = el("div", "detail__actions-end");
  const userEntries = entries.filter((entry) => entry.exists && !entry.protected);
  if (userEntries.length > 0) {
    const allHidden = userEntries.every((entry) => entry.hidden);
    const toggle = actionButton(
      allHidden ? "eye-filled" : "eye-cancelled-filled",
      allHidden ? t("detail.showFont") : t("detail.hideFont"),
      "btn btn--solid",
    );
    toggle.disabled = ctx.isTogglePending(userEntries);
    toggle.addEventListener("click", () => handlers.toggleHidden(userEntries));
    actions.appendChild(toggle);
  } else if (entries.some((entry) => entry.protected)) {
    // 整族都受保护：锁
    const lock = el("span", "cell__lock detail__lock");
    const lockSvg = icon("lock", "lock");
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = t("switch.protectedTitle", {
      protection: protectionLabel(entries[0].protection) || t("detail.protected"),
    });
    lockSvg.appendChild(title);
    lock.appendChild(lockSvg);
    actions.appendChild(lock);
  }

  const removable = entries.filter((entry) => entry.exists && !entry.protected);
  const exportable = entries.filter((entry) => entry.exists);
  const menuItems: MenuItem[] = [];
  if (exportable.length > 0) {
    menuItems.push({
      label: t("detail.exportFont"),
      icon: "export",
      run: () => handlers.exportFonts(exportable),
    });
  }
  menuItems.push({
    label: t("detail.reveal"),
    icon: "folder-open-filled",
    disabled: true,
  });
  if (entries.some((entry) => entry.exists)) {
    menuItems.push({
      label: t("detail.delete"),
      icon: "trashcan-filled",
      danger: removable.length > 0,
      disabled: removable.length === 0,
      run: removable.length > 0 ? () => handlers.requestDelete(removable) : undefined,
    });
  }
  if (menuItems.some((item) => !item.disabled)) trailing.appendChild(actionsMenu(menuItems));
  actions.appendChild(trailing);
  container.appendChild(actions);

  const info: HTMLElement[] = [kv(t("detail.family"), family)];
  const languages = [
    ...new Set(
      entries.flatMap((entry) => entry.languages ?? []),
    ),
  ];
  info.push(
    kv(
      t("detail.language"),
      languages.length ? languageList(languages) : t("language.unknown"),
    ),
    kv(t("detail.features"), featureList(entries)),
  );
  const version = entries.find((entry) => entry.version)?.version;
  if (version) info.push(kv(t("detail.version"), version));
  const copyright = entries.find((entry) => entry.copyright)?.copyright;
  if (copyright) info.push(kv(t("detail.copyright"), copyright));
  // 元信息独立滚动，标题 / 样字 / 操作区保持固定
  const scroll = el("div", "detail__scroll");
  scroll.appendChild(section(t("detail.sectionFont"), info));
  container.appendChild(scroll);
}