"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function RenamerPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/filing");
  }, [router]);

  return (
    <div className="silk-surface flex h-screen items-center justify-center bg-[#e9edf3] text-slate-700">
      <div className="silk-raised rounded-2xl px-6 py-5 text-center">
        <p className="text-sm">AIリネーマーはAIファイリングスタジオに統合されました。</p>
        <Link href="/filing" className="mt-3 inline-block text-sm text-blue-600 underline">
          移動しない場合はこちら
        </Link>
      </div>
    </div>
  );
}

