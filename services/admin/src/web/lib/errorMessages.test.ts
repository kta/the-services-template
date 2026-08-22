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
    [400, 'エラーが発生しました（400）'],
    [200, 'エラーが発生しました'],
  ])('maps status %i to a user-facing message', (status, expected) => {
    expect(messageForStatus(status)).toBe(expected)
  })

  it.each([
    ['email_taken', undefined, '既に使われています。内容を確認してください。'],
    ['expired', undefined, 'セッションが切れました。再度ログインしてください。'],
    ['unauthorized', undefined, 'セッションが切れました。再度ログインしてください。'],
    ['no_session', undefined, 'セッションが切れました。再度ログインしてください。'],
    ['not_found', undefined, '対象が見つかりませんでした。'],
    ['forbidden', undefined, 'この操作を行う権限がありません。'],
    ['operator_only', undefined, 'この操作を行う権限がありません。'],
    ['unknown', 403, 'この操作を行う権限がありません。'],
    ['unknown', undefined, 'エラーが発生しました（unknown）'],
    [undefined, undefined, '通信に失敗しました。時間をおいて再度お試しください。'],
  ])('maps code %s with status %s through the public error boundary', (code, status, expected) => {
    expect(messageForError({ code, status })).toBe(expected)
  })

  it.each([
    [{ code: 'email_taken' }, '既に使われています。内容を確認してください。'],
    [{ status: 404 }, '対象が見つかりませんでした。'],
    [{ status: '404' }, '通信に失敗しました。時間をおいて再度お試しください。'],
    [new Error('offline'), '通信に失敗しました。時間をおいて再度お試しください。'],
  ])('maps API failures and malformed values', (error, expected) => {
    expect(messageForError(error)).toBe(expected)
  })
})
