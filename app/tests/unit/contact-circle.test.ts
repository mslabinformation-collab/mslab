import { describe, expect, test } from "vitest";
import { circleReach, draggedPoint } from "@/components/admin/ContactCircle";

// Koolitaja's „Kontaktifoto“ circle (UX pass 11.11, A11): how far a drag moves the picture's point. The picture covers the circle, placed by the point
// and zoomed about it (domain/site-editor.ts circleCrop), so a change of the point by dp moves it by dp·(S − zW): the picture follows the pointer.

describe("the circle's reach", () => {
  test("the zoomed cover size less the circle's, per axis; none where the picture just fills it", () => {
    // a 400 × 600 photo in the 160 px circle: covered at 160 × 240
    expect(circleReach(160, { width: 400, height: 600 }, 100)).toEqual({ x: 0, y: 80 });
    // zoomed to 200 %: 320 × 480
    expect(circleReach(160, { width: 400, height: 600 }, 200)).toEqual({ x: 160, y: 320 });
    // a broken zoom is the picture just filling the circle
    expect(circleReach(160, { width: 600, height: 400 }, 999)).toEqual({ x: 80, y: 0 });
  });

  test("nothing before the picture has loaded (no size yet)", () => {
    expect(circleReach(0, { width: 400, height: 600 }, 100)).toBeNull();
    expect(circleReach(160, { width: 0, height: 0 }, 100)).toBeNull();
  });
});

describe("a drag", () => {
  test("the picture follows the pointer: a drag down shows more of its top, a drag left more of its right", () => {
    expect(draggedPoint({ x: 50, y: 20 }, { x: 0, y: 80 }, 30, 8)).toBe("50% 10%");
    expect(draggedPoint({ x: 50, y: 50 }, { x: 160, y: 320 }, -16, 0)).toBe("60% 50%");
  });

  test("the point stays within the picture", () => {
    expect(draggedPoint({ x: 50, y: 20 }, { x: 0, y: 80 }, 0, 400)).toBe("50% 0%");
    expect(draggedPoint({ x: 90, y: 20 }, { x: 160, y: 80 }, -400, -400)).toBe("100% 100%");
  });
});
