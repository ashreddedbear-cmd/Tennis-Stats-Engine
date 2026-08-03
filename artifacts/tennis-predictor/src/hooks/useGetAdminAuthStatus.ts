import { useQuery } from '@tanstack/react-query'

export interface AdminAuthStatus {
  authenticated: boolean
}

export function useGetAdminAuthStatus() {
  return useQuery<AdminAuthStatus>({
    queryKey: ['/api/auth/status'],
    queryFn: async () => {
      const res = await fetch('/api/auth/status', {
        credentials: 'include',
      })
      if (!res.ok) {
        throw new Error('Failed to fetch admin auth status')
      }
      return res.json()
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 1,
  })
}
