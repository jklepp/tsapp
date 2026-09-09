export type StatusData = {
  status: string;
  service: string;
};

export async function getHealth(): Promise<StatusData> {
  const response = await fetch("/api/health");

  if (!response.ok) {
    throw new Error("Failed to load health status");
  }

  return response.json();
}
