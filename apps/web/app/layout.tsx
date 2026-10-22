import type { Metadata } from 'next';
import './globals.css';
import './workspace.css';
export const metadata: Metadata = {
  title: 'DockSlot',
  description: 'Open-source dock scheduling and human-approved recovery.',
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
