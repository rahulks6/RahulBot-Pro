import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, View } from "react-native";

const LONG_PRESS_MS = 300;
const MOVE_CANCEL_THRESHOLD = 8; // a touch that moves this far before the long-press timer fires is a scroll/tap, not a drag

interface Point {
  left: number;
  top: number;
}

interface DraggableGridItemProps {
  itemKey: string;
  left: number;
  top: number;
  width: number;
  height: number;
  draggable: boolean;
  onDragStart: (key: string) => void;
  onDragMove: (key: string, dx: number, dy: number) => void;
  onDragEnd: (key: string) => void;
  onPress: () => void;
  children: React.ReactNode;
}

function DraggableGridItem({
  itemKey,
  left,
  top,
  width,
  height,
  draggable,
  onDragStart,
  onDragMove,
  onDragEnd,
  onPress,
  children,
}: DraggableGridItemProps): React.JSX.Element {
  const [isDragging, setIsDragging] = useState(false);
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const animatedLeft = useRef(new Animated.Value(left)).current;
  const animatedTop = useRef(new Animated.Value(top)).current;

  // The PanResponder below is created once per item (memoized on identity
  // that never changes post-mount) and must still call whatever the
  // *latest* callback props are — a stale one could fire onReorder with a
  // stale closure over the parent's own state. Read through this ref
  // instead of closing over the props directly.
  const callbacksRef = useRef({ onDragStart, onDragMove, onDragEnd, onPress });
  callbacksRef.current = { onDragStart, onDragMove, onDragEnd, onPress };

  // Siblings reflow as the drag passes over them — but never fight the
  // actively-dragged item's own base position (it's meant to sit frozen
  // under the finger via `pan`, not also animate toward its live slot).
  useEffect(() => {
    if (isDragging) return;
    Animated.parallel([
      Animated.timing(animatedLeft, { toValue: left, duration: 180, useNativeDriver: false }),
      Animated.timing(animatedTop, { toValue: top, duration: 180, useNativeDriver: false }),
    ]).start();
  }, [left, top, isDragging, animatedLeft, animatedTop]);

  const responder = useMemo(() => {
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let armed = false;

    const clearTimer = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    return PanResponder.create({
      onStartShouldSetPanResponder: () => draggable,
      onPanResponderGrant: () => {
        armed = false;
        pan.setValue({ x: 0, y: 0 });
        longPressTimer = setTimeout(() => {
          armed = true;
          setIsDragging(true);
          callbacksRef.current.onDragStart(itemKey);
        }, LONG_PRESS_MS);
      },
      onPanResponderMove: (_evt, gesture) => {
        if (!armed) {
          if (Math.abs(gesture.dx) > MOVE_CANCEL_THRESHOLD || Math.abs(gesture.dy) > MOVE_CANCEL_THRESHOLD) {
            clearTimer();
          }
          return;
        }
        pan.setValue({ x: gesture.dx, y: gesture.dy });
        callbacksRef.current.onDragMove(itemKey, gesture.dx, gesture.dy);
      },
      onPanResponderRelease: (_evt, gesture) => {
        clearTimer();
        if (armed) {
          setIsDragging(false);
          Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start();
          callbacksRef.current.onDragEnd(itemKey);
        } else if (Math.abs(gesture.dx) < MOVE_CANCEL_THRESHOLD && Math.abs(gesture.dy) < MOVE_CANCEL_THRESHOLD) {
          // Released cleanly before the long-press threshold, without
          // drifting — a plain tap. Handled entirely here rather than via
          // a nested <Pressable>: this view's PanResponder already claims
          // the touch responder at start (it has to, to ever detect a
          // long-press-and-drag at all), and RN's responder negotiation
          // resolves bottom-up — a child Pressable one level in would
          // claim the touch before this view's own PanResponder ever got
          // a chance, silently breaking the drag gesture entirely.
          callbacksRef.current.onPress();
        }
        armed = false;
      },
      onPanResponderTerminate: () => {
        clearTimer();
        if (armed) {
          setIsDragging(false);
          pan.setValue({ x: 0, y: 0 });
          callbacksRef.current.onDragEnd(itemKey);
        }
        armed = false;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggable, itemKey]);

  return (
    <Animated.View
      style={[
        styles.item,
        {
          width,
          height,
          left: animatedLeft,
          top: animatedTop,
          transform: pan.getTranslateTransform(),
          zIndex: isDragging ? 10 : 1,
          elevation: isDragging ? 10 : 0,
          opacity: isDragging ? 0.9 : 1,
        },
      ]}
    >
      {draggable ? (
        // Only ever attaches the PanResponder while this grid is actually
        // in reorder mode — see DraggableGrid's own doc comment for why
        // that's what makes this safe to use inside a ScrollView at all.
        <View {...responder.panHandlers} style={styles.fill}>
          {children}
        </View>
      ) : (
        // Not in reorder mode: a completely ordinary Pressable, no
        // PanResponder anywhere in this subtree — the enclosing
        // ScrollView (if any) gets touch priority exactly as if this
        // component didn't exist.
        <Pressable style={styles.fill} onPress={onPress}>
          {children}
        </Pressable>
      )}
    </Animated.View>
  );
}

export interface DraggableGridProps<T> {
  data: T[];
  keyExtractor: (item: T) => string;
  columns: number;
  itemWidth: number;
  itemHeight: number;
  gap: number;
  renderItem: (item: T) => React.ReactNode;
  /** Fired once, when a drag ends — the reordered array, ready to persist. Never fired for a plain tap (no long-press threshold reached). */
  onReorder: (newOrder: T[]) => void;
  /** Fired on a plain tap — see this component's own doc comment for why this replaces a nested `<Pressable>`'s onPress. Omit if items aren't individually tappable. */
  onPress?: (item: T) => void;
  /**
   * Whether items can actually be picked up at all — default `true`.
   * Pass `false` while this grid sits inside a `ScrollView`/`FlatList`
   * ancestor whose own scrolling matters (see this component's own doc
   * comment): with this `false`, no item ever attaches a PanResponder,
   * so the ancestor scrolls completely normally, at the cost of no drag
   * gesture being available at all until it's flipped back to `true`
   * (e.g. behind an explicit "Reorder" toggle the caller owns).
   */
  draggable?: boolean;
  /**
   * Reserves this many leading grid slots (starting at slot 0) that `data`
   * itself doesn't occupy or reflow into — for a fixed, non-reorderable
   * leading tile (HighlightsRow.tsx's "+ New" card always stays first).
   * The reserved slots are otherwise empty space here; render the tile
   * itself via `leadingChildren`, absolutely positioned by the caller —
   * slot 0 is always {left: 0, top: 0} regardless of `columns`.
   */
  startIndex?: number;
  leadingChildren?: React.ReactNode;
}

/**
 * A long-press-to-drag reorderable grid, hand-rolled with PanResponder —
 * no drag-and-drop library is installed (no npm registry access in this
 * sandbox; see backend/README.md's own note on the same constraint).
 * Used for both Highlights' own order (HighlightsRow.tsx, `columns=3`)
 * and a Highlight's content order (HighlightEditorScreen.tsx's selected
 * strip, `columns=data.length` so everything sits in one draggable row).
 *
 * `renderItem` should return plain (non-Pressable) visual content only —
 * `onPress` is a separate prop, called on a plain tap (released before the
 * long-press threshold, without drifting). Nesting a `<Pressable>` inside
 * a draggable item wouldn't work while `draggable` is true: this
 * component's own PanResponder has to claim the touch responder at the
 * very start to ever detect a long-press, and RN's responder negotiation
 * resolves bottom-up, so a child Pressable would claim it first and the
 * drag would never fire. This is also exactly why `draggable` exists as
 * its own prop rather than being always-on: claiming the responder at
 * touch-*down* (unavoidable for detecting stillness) also means a
 * ScrollView ancestor can't scroll starting from a touch on this grid
 * while it's true. `draggable={false}` (the default's opposite — see
 * that prop's own doc) sidesteps the conflict entirely rather than just
 * accepting it: no PanResponder is even created in that state, so an
 * ancestor ScrollView scrolls exactly as if this component weren't
 * there. HighlightsRow.tsx uses this for a real "Reorder" mode toggle,
 * rather than leaving drag permanently on and the ancestor page
 * permanently unscrollable-from-a-Highlight-card.
 */
export function DraggableGrid<T>({
  data,
  keyExtractor,
  columns,
  itemWidth,
  itemHeight,
  gap,
  renderItem,
  onReorder,
  onPress,
  draggable = true,
  startIndex = 0,
  leadingChildren,
}: DraggableGridProps<T>): React.JSX.Element {
  const [order, setOrder] = useState<T[]>(data);
  const orderRef = useRef(order);
  orderRef.current = order;
  const dragOriginRef = useRef<Point | null>(null);
  const draggingKeyRef = useRef<string | null>(null);

  // Resync from the parent's data whenever it changes from outside (a
  // fresh fetch, an item added/removed) — but never mid-drag, which
  // manages `order` itself.
  useEffect(() => {
    if (draggingKeyRef.current === null) setOrder(data);
  }, [data]);

  const cellWidth = itemWidth + gap;
  const cellHeight = itemHeight + gap;

  const positionFor = useCallback(
    (index: number): Point => {
      const slot = index + startIndex;
      return { left: (slot % columns) * cellWidth, top: Math.floor(slot / columns) * cellHeight };
    },
    [columns, cellWidth, cellHeight, startIndex],
  );

  const indexFromOffset = useCallback(
    (left: number, top: number, count: number): number => {
      const col = Math.min(columns - 1, Math.max(0, Math.round(left / cellWidth)));
      const row = Math.max(0, Math.round(top / cellHeight));
      const slot = row * columns + col;
      return Math.min(count - 1, Math.max(0, slot - startIndex));
    },
    [columns, cellWidth, cellHeight, startIndex],
  );

  const onDragStart = useCallback(
    (key: string) => {
      draggingKeyRef.current = key;
      const index = orderRef.current.findIndex((item) => keyExtractor(item) === key);
      if (index === -1) return;
      dragOriginRef.current = positionFor(index);
    },
    [keyExtractor, positionFor],
  );

  const onDragMove = useCallback(
    (key: string, dx: number, dy: number) => {
      const origin = dragOriginRef.current;
      if (!origin) return;
      const absLeft = origin.left + dx;
      const absTop = origin.top + dy;
      setOrder((current) => {
        const fromIndex = current.findIndex((item) => keyExtractor(item) === key);
        if (fromIndex === -1) return current;
        const toIndex = indexFromOffset(absLeft, absTop, current.length);
        if (toIndex === fromIndex) return current;
        const next = current.slice();
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved as T);
        return next;
      });
    },
    [keyExtractor, indexFromOffset],
  );

  const onDragEnd = useCallback(() => {
    draggingKeyRef.current = null;
    dragOriginRef.current = null;
    onReorder(orderRef.current);
  }, [onReorder]);

  const totalSlots = order.length + startIndex;
  const rows = Math.ceil(totalSlots / columns);
  const containerHeight = rows > 0 ? rows * cellHeight - gap : 0;

  return (
    <View style={[styles.container, { height: containerHeight }]}>
      {leadingChildren}
      {order.map((item, index) => {
        const key = keyExtractor(item);
        const { left, top } = positionFor(index);
        return (
          <DraggableGridItem
            key={key}
            itemKey={key}
            left={left}
            top={top}
            width={itemWidth}
            height={itemHeight}
            draggable={draggable}
            onDragStart={onDragStart}
            onDragMove={onDragMove}
            onDragEnd={onDragEnd}
            onPress={() => onPress?.(item)}
          >
            {renderItem(item)}
          </DraggableGridItem>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: "100%", position: "relative" },
  item: { position: "absolute" },
  fill: { flex: 1 },
});
