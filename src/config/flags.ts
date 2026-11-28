/**
 * Release flags (docs/10). Both default to off; turning either on is gated by an
 * owner approval recorded in progress/APPROVALS.md.
 */
function flag(name: string): boolean {
  return process.env[name] === "true";
}

export const FLAGS = {
  publicReleaseEnabled: flag("PUBLIC_RELEASE_ENABLED"),
  /** Lets signed-out visitors read approved public profiles, reviews and lists. Off when
   *  hosted; on only in the local test environment. The database has its own switch
   *  as well (app.platform_switches) and both must be on (docs/17 D-M5-GUEST). */
  socialPublicEnabled: flag("SOCIAL_PUBLIC_ENABLED"),
  /** Demo content is only ever shown when explicitly allowed (local development). */
  allowDemoContent: flag("ALLOW_DEMO_CONTENT"),
  /** Map Discovery (MAP-1). Off unless set; on only in local development and tests until the
   *  owner approves otherwise. With it off no map control, script or route is reachable. */
  mapEnabled: flag("MAP_ENABLED"),
  /** Private real-catalog preview (docs/32). Off unless set; on only in local development. With it on,
   *  only a signed-in founder (publisher or admin role, checked by the database) sees real places;
   *  everyone else sees nothing new. It never makes a place public: that needs the database's own
   *  real-place lock, which is off. */
  realCatalogPreview: flag("REAL_CATALOG_PREVIEW"),
  /** Demo-to-real transition (docs/37). Discover leads with real places and says plainly that no dish is
   *  checked yet. It only takes effect when demo content is off (ALLOW_DEMO_CONTENT unset or false), so
   *  invented and real places are never mixed in one result. It hides demo rows; it never deletes them.
   *  Which real places a visitor sees is still decided by the database (founder preview only while
   *  the real-place lock is off). Undo: unset REAL_DISCOVERY and set ALLOW_DEMO_CONTENT=true again. */
  realDiscovery: flag("REAL_DISCOVERY") && !flag("ALLOW_DEMO_CONTENT"),
  /** Restaurant submissions (docs/48). Off unless set; on only in local development and tests. With it on, a
   *  signed-in person with a claim link can claim a place and, once a moderator has checked ownership,
   *  upload a menu into the private moderation queue. Nothing submitted is ever shown publicly. */
  partnerSubmissions: flag("PARTNER_SUBMISSIONS"),
} as const;
