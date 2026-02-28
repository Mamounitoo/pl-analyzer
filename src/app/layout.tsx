import "./globals.css";
import { PlSessionProvider } from "@/lib/pl/PlSessionContext";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PlSessionProvider>{children}</PlSessionProvider>
      </body>
    </html>
  );
}