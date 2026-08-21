/**
 * admin↔ドメイン(example_service)org 同期の日次照合。副作用を注入する純ロジックで、
 * scheduled ハンドラと unit テストが同じ関数を使う。ドメイン側のミラーが admin の正と
 * ずれている(欠落・plan/isDisabled/name 相違)org を再 upsert し、ずれがあれば
 * 1 通だけ `ops.sync_drift` を送る。
 */

export type AdminOrgRow = { id: string; name: string; plan: string; isDisabled: boolean }

/** ドメイン側同期行の比較対象フィールド(Organization のサブセット)。 */
export type DomainOrgRow = { id: string; name: string; plan: string; isDisabled: boolean }

/**
 * 1 回の照合で再 upsert する上限。Workers 無料枠は 1 呼び出し 50 サブリクエストで、
 * 一覧取得 + 通知も同じ枠を使うため余裕を残す。超過分(truncated)は翌日の照合が
 * 拾う(通知 payload で truncated を報せる)。
 */
export const MAX_RESYNC_PER_RUN = 40

export type ReconcileResult = {
  /** ずれていた org id(再 upsert 対象。truncated 分も含む)。 */
  drift: string[]
  /** 再 upsert を試みて失敗した org id。 */
  failed: string[]
  /** MAX_RESYNC_PER_RUN 超過で今回スキップした分があるか。 */
  truncated: boolean
}

// A はジェネリック: listAdminOrgs が返した行がそのまま resync に渡るため、呼び出し
// 側は createdAt 等の追加フィールドを持ち回れる(org ごとの再 SELECT = N+1 を防ぐ)。
export type ReconcileDeps<A extends AdminOrgRow = AdminOrgRow> = {
  listAdminOrgs: () => Promise<A[]>
  listDomainOrgs: () => Promise<DomainOrgRow[]>
  /** 再 upsert(best-effort)。false = 失敗(結果は通知 payload に載る)。 */
  resync: (org: A) => Promise<boolean>
  notifyDrift: (result: ReconcileResult) => Promise<void>
}

export async function reconcileOrgs<A extends AdminOrgRow>(
  deps: ReconcileDeps<A>,
): Promise<ReconcileResult> {
  const [admins, domain] = await Promise.all([deps.listAdminOrgs(), deps.listDomainOrgs()])
  const byId = new Map(domain.map((d) => [d.id, d]))
  const drift: string[] = []
  const failed: string[] = []
  let resynced = 0
  let truncated = false
  for (const a of admins) {
    const mirror = byId.get(a.id)
    const mismatched =
      !mirror ||
      mirror.plan !== a.plan ||
      mirror.isDisabled !== a.isDisabled ||
      mirror.name !== a.name
    if (!mismatched) continue
    drift.push(a.id)
    if (resynced >= MAX_RESYNC_PER_RUN) {
      truncated = true
      continue
    }
    resynced += 1
    if (!(await deps.resync(a))) failed.push(a.id)
  }
  const result: ReconcileResult = { drift, failed, truncated }
  if (drift.length > 0) await deps.notifyDrift(result)
  return result
}
