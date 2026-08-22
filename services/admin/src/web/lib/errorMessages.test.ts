import { describe, expect, it } from 'vitest'
import { messageForError, messageForStatus } from './errorMessages'

describe('admin error messages', () => {
  it.each([
    [0, '通信に失敗しました。時間をおいて再度お試しください。'],
    [401, 'セッションが切れました。再度ログインしてください。'],
    [403, 'この操作を行う権限がありません。'],
    [404, '対象が見つかりませんでした。'],
    [409, '既に使われています。内容を確認してください。'],
    [429, '通信に失敗しました。時間をおいて再度お試しください。'],
    [500, '通信に失敗しました。時間をおいて再度お試しください。'],
    [422, 'エラーが発生しました（422）'],
    [200, 'エラーが発生しました'],
  ])('maps status %i to a user-facing message', (status, expected) => {
    expect(messageForStatus(status)).toBe(expected)
  })

  it.each([
    [{ code: 'email_taken' }, '既に使われています。内容を確認してください。'],
    [{ code: 'expired' }, 'セッションが切れました。再度ログインしてください。'],
    [{ code: 'not_found' }, '対象が見つかりませんでした。'],
    [{ code: 'operator_only' }, 'この操作を行う権限がありません。'],
    [{ code: 'other', status: 403 }, 'この操作を行う権限がありません。'],
    [{ code: 'other' }, 'エラーが発生しました（other）'],
    [{ status: 404 }, '対象が見つかりませんでした。'],
    [{ status: '404' }, '通信に失敗しました。時間をおいて再度お試しください。'],
    [new Error('offline'), '通信に失敗しました。時間をおいて再度お試しください。'],
  ])(
    'maps API failures and unknown values without leaking implementation details',
    (error, expected) => {
      expect(messageForError(error)).toBe(expected)
    },
  )
})
