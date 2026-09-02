export const getApiUrl = (): string => {
    const apiUrl = import.meta.env.VITE_API_URL as string | undefined;
    if (apiUrl) return apiUrl.replace(/\/$/, '');
    return `${window.location.origin}/api`;
};

/**
 * Token de autenticacao compartilhado com o backend (SAFENAP_AUTH_TOKEN).
 * Quando o backend tem auth ativa, o frontend precisa enviar este token.
 * Vazio = backend em modo dev sem auth.
 */
export const getAuthToken = (): string => {
    return (import.meta.env.VITE_AUTH_TOKEN as string | undefined)?.trim() ?? '';
};

/** Headers comuns para chamadas autenticadas ao backend. */
export const getAuthHeaders = (): Record<string, string> => {
    const token = getAuthToken();
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
};
