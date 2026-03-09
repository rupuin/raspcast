export async function login(pin: string): Promise<void> {
  const response = await fetch('/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  })

  if (!response.ok) {
    throw new Error(response.status === 401 ? 'Invalid PIN' : 'Login failed')
  }
}

export async function checkAuth(): Promise<boolean> {
  const response = await fetch('/auth')

  if (!response.ok) {
    throw new Error('Auth check failed')
  }

  const data = (await response.json()) as { authenticated: boolean }
  return data.authenticated
}
