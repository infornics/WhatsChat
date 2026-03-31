import { ReactNode } from "react";
import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "WhatsChat",
    template: "%s | WhatsChat",
  },
  description:
    "Upload a WhatsApp export zip and turn it into a clean, readable chat experience in the browser.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
