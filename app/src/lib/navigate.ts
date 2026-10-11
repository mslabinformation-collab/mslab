/**
 * Sends the browser to another site's page with a full page load, never through the client router (phase 2b: Montonio's payment page). One
 * function, so the DOM tests can stand in for it (vi.mock("@/lib/navigate")).
 */
export function navigate(url: string): void {
  window.location.assign(url);
}
