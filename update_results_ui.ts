import fs from 'fs';

let content = fs.readFileSync('src/routes/results.tsx', 'utf8');

const oldRendering = `                {group.partialRestaurants && group.partialRestaurants.length > 0 && (
                  <div className="mt-8">
                    <div className="mb-3 border-l-4 border-warning pl-3">
                      <h3 className="text-base font-semibold tracking-tight">
                        {t("results.partialTitle")}
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">{t("results.partialDesc")}</p>
                    </div>
                    <div className="space-y-5">
                      {group.partialRestaurants.map((r, i) => (
                        <RestaurantCard key={r.id} index={i + 1} r={r} tierLabel={TIER_LABEL} tierClass={TIER_CLASS} />
                      ))}
                    </div>
                  </div>
                )}`;

const newRendering = `                {/* All OK candidates that are not in the top 5 */}
                {(() => {
                  const topIds = new Set(group.restaurants.map(r => r.id));
                  const otherOk = (group.okRestaurants || []).filter(r => !topIds.has(r.id));
                  if (otherOk.length === 0) return null;
                  return (
                    <div className="mt-8">
                      <div className="mb-3 border-l-4 border-primary/40 pl-3">
                        <h3 className="text-base font-semibold tracking-tight text-muted-foreground">
                          {t("results.otherOkTitle") || "Verified Candidates"}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">{t("results.otherOkDesc") || "These restaurants match your criteria but didn't make the top list."}</p>
                      </div>
                      <div className="space-y-5 opacity-80">
                        {otherOk.map((r, i) => (
                          <RestaurantCard key={r.id} index={group.restaurants.length + i + 1} r={r} tierLabel={TIER_LABEL} tierClass={TIER_CLASS} />
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* All Partial/Unknown candidates that are not in the top 5 */}
                {(() => {
                  const topIds = new Set(group.restaurants.map(r => r.id));
                  const otherPartial = (group.partialRestaurants || []).filter(r => !topIds.has(r.id));
                  if (otherPartial.length === 0) return null;
                  return (
                    <div className="mt-8">
                      <div className="mb-3 border-l-4 border-warning pl-3">
                        <h3 className="text-base font-semibold tracking-tight text-muted-foreground">
                          {t("results.partialTitle")}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">{t("results.partialDesc")}</p>
                      </div>
                      <div className="space-y-5 opacity-70">
                        {otherPartial.map((r, i) => (
                          <RestaurantCard key={r.id} index={group.restaurants.length + (group.okRestaurants?.length || 0) + i + 1} r={r} tierLabel={TIER_LABEL} tierClass={TIER_CLASS} />
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* Failed Candidates */}
                {group.failedRestaurants && group.failedRestaurants.length > 0 && (
                  <div className="mt-8">
                    <details className="group">
                      <summary className="flex items-center gap-2 cursor-pointer list-none">
                        <div className="mb-3 border-l-4 border-destructive pl-3">
                          <h3 className="text-base font-semibold tracking-tight text-destructive/80">
                            {t("results.failedTitle") || "Mismatched Candidates"}
                          </h3>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t("results.failedDesc") || "These do not meet your mandatory criteria. Click to show."}
                          </p>
                        </div>
                      </summary>
                      <div className="space-y-5 opacity-50 mt-4 grayscale">
                        {group.failedRestaurants.map((r, i) => (
                          <RestaurantCard key={r.id} index={0} r={r} tierLabel={TIER_LABEL} tierClass={TIER_CLASS} />
                        ))}
                      </div>
                    </details>
                  </div>
                )}`;

content = content.replace(oldRendering, newRendering);
fs.writeFileSync('src/routes/results.tsx', content);
