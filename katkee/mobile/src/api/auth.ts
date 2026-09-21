import { apiGet, apiPost, type PublicUser, type TokenPair } from "./client";

export interface SignupPayload {
  username: string;
  email: string;
  password: string;
  displayName: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

interface AuthResponse {
  user: PublicUser;
  tokens: TokenPair;
}

export function signup(payload: SignupPayload): Promise<AuthResponse> {
  return apiPost<AuthResponse>("/api/v1/auth/signup", payload);
}

export function login(payload: LoginPayload): Promise<AuthResponse> {
  return apiPost<AuthResponse>("/api/v1/auth/login", payload);
}

export function refresh(refreshToken: string): Promise<{ tokens: TokenPair }> {
  return apiPost<{ tokens: TokenPair }>("/api/v1/auth/refresh", { refreshToken });
}

export function logout(refreshToken: string): Promise<void> {
  return apiPost<void>("/api/v1/auth/logout", { refreshToken });
}

export function fetchMe(accessToken: string): Promise<{ user: PublicUser }> {
  return apiGet<{ user: PublicUser }>("/api/v1/auth/me", accessToken);
}
