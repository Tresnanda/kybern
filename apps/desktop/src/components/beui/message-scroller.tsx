/* eslint-disable react-hooks/immutability -- ported from beui.dev as-is */
// beui.dev/components/agents/message-scroller

import { observeResizeFrame } from "@/lib/resizeObserver"
import { useReducedMotion } from "motion/react";
import {
  type ComponentPropsWithRef,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  PreviewRail,
  type PreviewRailItem,
} from "@/components/beui/preview-rail";
import { cn } from "@/lib/utils";

const PREVIEW_TITLE_LENGTH = 56;
const PREVIEW_DESCRIPTION_LENGTH = 88;

function truncateMessageText(text: string, limit: number) {
  if (text.length <= limit) return text;
  const excerpt = text.slice(0, limit);
  const boundary = excerpt.lastIndexOf(" ");
  return `${excerpt.slice(0, boundary > limit * 0.65 ? boundary : limit).trim()}…`;
}

function getMessageText(message: HTMLElement, cache: WeakMap<HTMLElement, string>) {
  const cached = cache.get(message);
  if (cached !== undefined) return cached;
  const surface =
    message.querySelector<HTMLElement>('[data-slot="message-bubble-content"]') ??
    message.querySelector<HTMLElement>('[data-slot="message-content"]') ??
    message;
  // A rail preview needs only a short prefix, never a whole highlighted block.
  const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
  const limit = PREVIEW_TITLE_LENGTH + PREVIEW_DESCRIPTION_LENGTH + 2;
  let text = "";
  let space = false;
  for (let node = walker.nextNode(); node && text.length <= limit; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    for (let index = 0; index < value.length && text.length <= limit; index++) {
      const char = value[index]!;
      if (/\s/.test(char)) {
        space = text.length > 0;
      } else {
        if (space) text += " ";
        text += char;
        space = false;
      }
    }
  }
  cache.set(message, text);
  return text;
}

function getMessagePreview(
  message: HTMLElement,
  cache: WeakMap<HTMLElement, string>,
  assistantResponse?: HTMLElement,
) {
  const text = getMessageText(message, cache);
  if (!text) {
    return { label: "Message", description: undefined };
  }

  if (text.length <= PREVIEW_TITLE_LENGTH) {
    const responseText = assistantResponse
      ? getMessageText(assistantResponse, cache)
      : "";
    return {
      label: text,
      description: responseText
        ? truncateMessageText(responseText, PREVIEW_DESCRIPTION_LENGTH)
        : undefined,
    };
  }

  const titleExcerpt = text.slice(0, PREVIEW_TITLE_LENGTH);
  const titleBoundary = titleExcerpt.lastIndexOf(" ");
  const titleEnd =
    titleBoundary > PREVIEW_TITLE_LENGTH * 0.65
      ? titleBoundary
      : PREVIEW_TITLE_LENGTH;
  const label = `${text.slice(0, titleEnd).trim()}…`;
  const responseText = assistantResponse
    ? getMessageText(assistantResponse, cache)
    : text.slice(titleEnd).trim();
  return {
    label,
    description: responseText
      ? truncateMessageText(responseText, PREVIEW_DESCRIPTION_LENGTH)
      : undefined,
  };
}

export interface MessageNavigationModel {
  items: readonly PreviewRailItem[];
  activeId: (viewport: HTMLElement) => string;
  scrollToItem: (id: string) => void;
  scrollToEnd: () => void;
}

export interface MessageScrollerProps extends ComponentPropsWithRef<"div"> {
  /** Keep streamed output pinned while the reader remains near the end. */
  followOutput?: boolean;
  /** Changing this value resumes following and jumps to the live edge. */
  followKey?: string | number | null;
  /** Distance from the end that still counts as following the output. */
  followThreshold?: number;
  /** Smoothly follow growing content. */
  smooth?: boolean;
  /** Reports when the reader leaves or returns to the live edge. */
  onFollowChange?: (following: boolean) => void;
  /** Accessible label for the scrollable transcript. */
  label?: string;
  /** Marks the transcript as waiting for more streamed content. */
  busy?: boolean;
  /** Adds a compact rail for navigating between rendered Message rows. */
  navigation?: "rail";
  /** Data-backed navigation for virtual transcripts; avoids reading unmounted DOM. */
  navigationModel?: MessageNavigationModel;
  /** Accessible label for the optional message navigation rail. */
  navigationLabel?: string;
  /** Which edge the rail sits on. */
  navigationSide?: "left" | "right";
  viewportClassName?: string;
  contentClassName?: string;
  railClassName?: string;
  viewportRef?: Ref<HTMLElement>;
  viewportProps?: Omit<
    ComponentPropsWithRef<"section">,
    "children" | "className" | "ref"
  >;
  contentProps?: Omit<
    ComponentPropsWithRef<"div">,
    "children" | "className" | "ref"
  >;
}

export function MessageScroller({
  followOutput = true,
  followKey,
  followThreshold = 56,
  smooth = true,
  onFollowChange,
  label = "Conversation",
  busy,
  navigation,
  navigationModel,
  navigationLabel = "Message navigation",
  navigationSide = "right",
  viewportClassName,
  contentClassName,
  railClassName,
  viewportRef: externalViewportRef,
  viewportProps,
  contentProps,
  className,
  children,
  ...props
}: MessageScrollerProps) {
  const reduce = useReducedMotion() ?? false;
  const navigationModelRef = useRef(navigationModel);
  useLayoutEffect(() => { navigationModelRef.current = navigationModel; }, [navigationModel]);
  const viewportRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(followOutput);
  const programmaticScrollRef = useRef(false);
  const scrollTimerRef = useRef<number | undefined>(undefined);
  const frameRef = useRef<number | undefined>(undefined);
  const railFrameRef = useRef<number | undefined>(undefined);
  const activeRailFrameRef = useRef<number | undefined>(undefined);
  const railTextCacheRef = useRef(new WeakMap<HTMLElement, string>());
  const railIdRef = useRef(new WeakMap<HTMLElement, string>());
  const railIdCounterRef = useRef(0);
  const railTargetsRef = useRef(new Map<string, HTMLElement>());
  const [railItems, setRailItems] = useState<readonly PreviewRailItem[]>([]);
  const [activeRailId, setActiveRailId] = useState("");
  const [railOverflowing, setRailOverflowing] = useState(false);
  const {
    onScroll: onViewportScroll,
    onWheel: onViewportWheel,
    onTouchStart: onViewportTouchStart,
    onKeyDown: onViewportKeyDown,
    ...restViewportProps
  } = viewportProps ?? {};

  const setViewportRef = useCallback(
    (node: HTMLElement | null) => {
      viewportRef.current = node;
      if (typeof externalViewportRef === "function") {
        externalViewportRef(node);
      } else if (externalViewportRef) {
        externalViewportRef.current = node;
      }
    },
    [externalViewportRef],
  );

  const setFollowing = useCallback(
    (next: boolean) => {
      if (followingRef.current === next) return;
      followingRef.current = next;
      onFollowChange?.(next);
    },
    [onFollowChange],
  );

  const updateActiveRailItem = useCallback(() => {
    if (navigation !== "rail") return;
    const viewport = viewportRef.current;
    if (viewport && navigationModel) {
      const id = viewport.scrollTop <= followThreshold ? navigationModel.items[0]?.id ?? ""
        : viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= followThreshold ? navigationModel.items.at(-1)?.id ?? ""
        : navigationModel.activeId(viewport);
      setActiveRailId((current) => current === id ? current : id);
      return;
    }
    const targets = [...railTargetsRef.current.entries()];
    if (!viewport || targets.length === 0) return;

    const viewportRect = viewport.getBoundingClientRect();
    if (viewport.scrollTop <= followThreshold) {
      const firstId = targets[0]?.[0] ?? "";
      setActiveRailId((current) => (current === firstId ? current : firstId));
      return;
    }

    const distanceFromEnd =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromEnd <= followThreshold) {
      const lastId = targets.at(-1)?.[0] ?? "";
      setActiveRailId((current) => (current === lastId ? current : lastId));
      return;
    }

    const viewportCenter = viewportRect.top + viewportRect.height / 2;
    let nearestId = targets[0]?.[0] ?? "";
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const [id, element] of targets) {
      const rect = element.getBoundingClientRect();
      const messageCenter = rect.top + rect.height / 2;
      const distance = Math.abs(messageCenter - viewportCenter);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestId = id;
      }
    }

    setActiveRailId((current) =>
      current === nearestId ? current : nearestId,
    );
  }, [followThreshold, navigation, navigationModel]);

  const syncRailItems = useCallback(() => {
    if (navigation !== "rail") return;
    const content = contentRef.current;
    const viewport = viewportRef.current;
    if (!content || !viewport) return;

    if (navigationModel) {
      setRailItems(navigationModel.items);
      setRailOverflowing(viewport.scrollHeight > viewport.clientHeight + 1 && navigationModel.items.length > 1);
      return;
    }

    const messages = Array.from(
      content.querySelectorAll<HTMLElement>('[data-slot="message"]'),
    );
    const targets = new Map<string, HTMLElement>();
    const nextItems = messages.map((message, index) => {
      let id = railIdRef.current.get(message);
      if (!id) {
        railIdCounterRef.current += 1;
        id = `message-rail-${railIdCounterRef.current}`;
        railIdRef.current.set(message, id);
      }
      targets.set(id, message);
      const sender = message.dataset.from ?? "conversation";
      const assistantResponse =
        sender === "user"
          ? messages
              .slice(index + 1)
              .find((candidate) => candidate.dataset.from === "assistant")
          : undefined;
      const preview = getMessagePreview(message, railTextCacheRef.current, assistantResponse);

      return {
        id,
        label: preview.label,
        description: preview.description,
        ariaLabel: `Go to ${sender} message ${index + 1} of ${messages.length}`,
      };
    });

    railTargetsRef.current = targets;
    setRailItems((current) => {
      const unchanged =
        current.length === nextItems.length &&
        current.every(
          (item, index) =>
            item.id === nextItems[index]?.id &&
            item.label === nextItems[index]?.label &&
            item.description === nextItems[index]?.description &&
            item.ariaLabel === nextItems[index]?.ariaLabel,
        );
      return unchanged ? current : nextItems;
    });
    setRailOverflowing(
      viewport.scrollHeight > viewport.clientHeight + 1 && messages.length > 1,
    );
  }, [navigation, navigationModel]);

  const scheduleRailSync = useCallback(() => {
    if (navigation !== "rail") return;
    if (railFrameRef.current) return;
    railFrameRef.current = requestAnimationFrame(() => {
      railFrameRef.current = undefined;
      syncRailItems();
      updateActiveRailItem();
    });
  }, [navigation, syncRailItems, updateActiveRailItem]);

  const scheduleActiveRailItem = useCallback(() => {
    if (navigation !== "rail" || activeRailFrameRef.current) return;
    activeRailFrameRef.current = requestAnimationFrame(() => {
      activeRailFrameRef.current = undefined;
      updateActiveRailItem();
    });
  }, [navigation, updateActiveRailItem]);

  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    programmaticScrollRef.current = true;
    if (navigationModelRef.current) {
      navigationModelRef.current.scrollToEnd();
    } else if (typeof viewport.scrollTo === "function") {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    } else {
      viewport.scrollTop = viewport.scrollHeight;
    }
    if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, behavior === "smooth" ? 320 : 0);
  }, []);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || programmaticScrollRef.current) return;

    const distance =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setFollowing(distance <= followThreshold);
    scheduleActiveRailItem();
  }, [followThreshold, setFollowing, scheduleActiveRailItem]);

  const leaveLiveEdge = useCallback(() => {
    programmaticScrollRef.current = false;
  }, []);

  useLayoutEffect(() => {
    if (!followOutput) {
      followingRef.current = false;
      return;
    }

    setFollowing(true);
    frameRef.current = requestAnimationFrame(() => scrollToEnd("auto"));
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [followKey, followOutput, scrollToEnd, setFollowing]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;

    return observeResizeFrame(content, () => {
      scheduleRailSync();
      if (!followOutput || !followingRef.current) return;
      scrollToEnd(reduce || !smooth ? "auto" : "smooth");
    });
  }, [followOutput, reduce, scheduleRailSync, scrollToEnd, smooth]);

  useEffect(() => {
    if (navigation !== "rail") {
      railTargetsRef.current.clear();
      setRailItems([]);
      setRailOverflowing(false);
      return;
    }

    const content = contentRef.current;
    const viewport = viewportRef.current;
    if (!content || !viewport) return;

    scheduleRailSync();
    const mutationObserver =
      navigationModel || typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            for (const record of records) {
              const element = record.target.nodeType === 1
                ? record.target as Element
                : record.target.parentElement;
              const message = element?.closest<HTMLElement>('[data-slot="message"]');
              if (message) {
                railTextCacheRef.current.delete(message);
              } else {
                // Reinserted message nodes may have changed while detached.
                for (const node of record.addedNodes) {
                  if (node.nodeType !== 1) continue;
                  const added = node as HTMLElement;
                  if (added.matches('[data-slot="message"]')) railTextCacheRef.current.delete(added);
                  for (const row of added.querySelectorAll<HTMLElement>('[data-slot="message"]')) railTextCacheRef.current.delete(row);
                }
              }
            }
            scheduleRailSync();
          });
    mutationObserver?.observe(content, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleRailSync);
    resizeObserver?.observe(content);
    resizeObserver?.observe(viewport);

    return () => {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
    };
  }, [navigation, navigationModel, scheduleRailSync]);

  useEffect(
    () => () => {
      if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      if (railFrameRef.current) cancelAnimationFrame(railFrameRef.current);
      if (activeRailFrameRef.current) cancelAnimationFrame(activeRailFrameRef.current);
    },
    [],
  );

  const scrollToRailItem = useCallback(
    (item: PreviewRailItem) => {
      const viewport = viewportRef.current;
      const target = railTargetsRef.current.get(item.id);
      if (!viewport || (!navigationModel && !target)) return;

      const lastItem = railItems.at(-1)?.id === item.id;
      setActiveRailId(item.id);
      if (lastItem) {
        setFollowing(true);
        scrollToEnd(reduce || !smooth ? "auto" : "smooth");
        return;
      }

      setFollowing(false);
      programmaticScrollRef.current = true;
      if (navigationModel) {
        navigationModel.scrollToItem(item.id);
        if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = window.setTimeout(() => { programmaticScrollRef.current = false; }, 320);
        return;
      }
      const viewportRect = viewport.getBoundingClientRect();
      const targetRect = target!.getBoundingClientRect();
      const top =
        viewport.scrollTop +
        targetRect.top -
        viewportRect.top -
        (viewport.clientHeight - targetRect.height) / 2;
      const behavior = reduce || !smooth ? "auto" : "smooth";

      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({ top, behavior });
      } else {
        viewport.scrollTop = top;
      }
      if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = window.setTimeout(() => {
        programmaticScrollRef.current = false;
      }, behavior === "smooth" ? 320 : 0);
    },
    [railItems, reduce, scrollToEnd, setFollowing, smooth, navigationModel],
  );

  const viewport = (
    <section
      ref={setViewportRef}
      aria-label={label}
      {...restViewportProps}
      onScroll={(event) => {
        handleScroll();
        onViewportScroll?.(event);
      }}
      onWheel={(event) => {
        leaveLiveEdge();
        onViewportWheel?.(event);
      }}
      onTouchStart={(event) => {
        leaveLiveEdge();
        onViewportTouchStart?.(event);
      }}
      onKeyDown={(event) => {
        if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
          leaveLiveEdge();
        }
        onViewportKeyDown?.(event);
      }}
      className={cn(
        "h-full overflow-y-auto overscroll-contain outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        navigation === "rail"
          ? "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          : "[scrollbar-gutter:stable]",
        viewportClassName,
        navigation === "rail" && railOverflowing && navigationSide === "right" && "!pr-10",
      )}
    >
      <div
        ref={contentRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={busy}
        className={contentClassName}
        {...contentProps}
      >
        {children}
      </div>
    </section>
  );

  return (
    <div
      data-slot="message-scroller"
      className={cn("min-h-0", className)}
      {...props}
    >
      {navigation === "rail" ? (
        <PreviewRail
          items={railOverflowing ? railItems : []}
          label={navigationLabel}
          activeId={activeRailId}
          onItemSelect={scrollToRailItem}
          previewSide={navigationSide === "left" ? "after" : "before"}
          highlightActive
          itemSize={14}
          className="h-full min-h-0 overflow-hidden"
          previewContainerClassName={navigationSide === "left" ? "left-14 right-3" : "right-8 left-3"}
          previewClassName={cn(
            navigationSide === "left" ? "ml-1" : "mr-1",
            "w-64 max-w-full [&_[data-slot=preview-rail-card]]:h-20 [&_[data-slot=preview-rail-card]]:overflow-hidden [&_[data-slot=preview-rail-card]]:p-3 [&_[data-slot=preview-rail-title]]:line-clamp-1 [&_[data-slot=preview-rail-title]]:text-xs [&_[data-slot=preview-rail-title]]:leading-4 [&_[data-slot=preview-rail-description]]:line-clamp-2 [&_[data-slot=preview-rail-description]]:text-xs [&_[data-slot=preview-rail-description]]:leading-4",
          )}
          railClassName={cn(
            "absolute inset-y-3 w-7 content-center py-1 [&_[data-slot=preview-rail-item]]:w-7 [&_[data-slot=preview-rail-tick]]:h-px [&_[data-slot=preview-rail-tick]]:w-4",
            navigationSide === "left"
              ? "left-5 [&_[data-slot=preview-rail-item]]:justify-start [&_[data-slot=preview-rail-tick]]:origin-left"
              : "right-1 [&_[data-slot=preview-rail-item]]:justify-end [&_[data-slot=preview-rail-tick]]:origin-right",
            railOverflowing
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0",
            railClassName,
          )}
        >
          {viewport}
        </PreviewRail>
      ) : (
        viewport
      )}
    </div>
  );
}
