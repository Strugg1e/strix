import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function isValidUrl(url: string): boolean {
  if (!url || !url.trim()) return false;

  try {
    // Add protocol if missing
    let urlWithProtocol = url.trim();
    if (!urlWithProtocol.startsWith("http://") && !urlWithProtocol.startsWith("https://")) {
      urlWithProtocol = `https://${urlWithProtocol}`;
    }
    const parsed = new URL(urlWithProtocol);
    // Check if it has a valid hostname with at least one dot (domain)
    return Boolean(parsed.hostname) && parsed.hostname.includes(".");
  } catch {
    return false;
  }
}

export function isValidDomain(domain: string | null): boolean {
  if (!domain) return false;

  // Basic domain validation regex
  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

  // Check basic format
  if (!domainRegex.test(domain)) {
    return false;
  }

  // Check length constraints
  if (domain.length > 253) {
    return false;
  }

  // Must have at least one dot (TLD required)
  if (!domain.includes(".")) {
    return false;
  }

  // Check each label length (max 63 chars per label)
  const labels = domain.split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      return false;
    }
  }

  // TLD should be at least 2 characters
  const tld = labels[labels.length - 1];
  if (tld.length < 2) {
    return false;
  }

  return true;
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return "刚刚";
  }
  if (diffInSeconds < 3600) {
    const minutes = Math.floor(diffInSeconds / 60);
    return `${minutes} 分钟前`;
  }
  if (diffInSeconds < 86400) {
    const hours = Math.floor(diffInSeconds / 3600);
    return `${hours} 小时前`;
  }
  if (diffInSeconds < 604800) {
    const days = Math.floor(diffInSeconds / 86400);
    return `${days} 天前`;
  }
  return formatDate(dateString);
}

export function formatTimeUntil(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffInSeconds = Math.floor((date.getTime() - now.getTime()) / 1000);

  if (diffInSeconds < 0) return "现在";
  if (diffInSeconds < 60) return "不到 1 分钟后";
  if (diffInSeconds < 3600) {
    const minutes = Math.floor(diffInSeconds / 60);
    return `${minutes} 分钟后`;
  }
  if (diffInSeconds < 86400) {
    const hours = Math.floor(diffInSeconds / 3600);
    return `${hours} 小时后`;
  }
  if (diffInSeconds < 604800) {
    const days = Math.round(diffInSeconds / 86400);
    return `${days || 1} 天后`;
  }
  return formatDate(dateString);
}
