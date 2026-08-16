export const getApiUrl = (): string => {
    const apiUrl = import.meta.env.VITE_API_URL as string | undefined;
    if (apiUrl) return apiUrl.replace(/\/$/, '');
    return `${window.location.origin}/api`;
};
