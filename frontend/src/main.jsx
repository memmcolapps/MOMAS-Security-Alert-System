import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import React from "react";
import { createRoot } from "react-dom/client";
import { DevicesRoute } from "./routes/DevicesRoute";
import { OperationsRoute } from "./routes/OperationsRoute";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function RootLayout() {
  return <Outlet />;
}

function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-ops-bg p-6 text-neutral-200">
      <div className="glass-panel max-w-sm rounded-lg p-6 text-center">
        <h1 className="text-lg font-bold text-ops-red">Page not found</h1>
        <p className="mt-2 text-xs text-neutral-500">
          This view is not registered in the operations console.
        </p>
        <Link
          to="/"
          className="mt-5 inline-flex rounded-md border border-ops-line px-4 py-2 text-xs font-bold text-ops-red hover:bg-red-500/10"
        >
          Back to map
        </Link>
      </div>
    </main>
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OperationsRoute,
});

const devicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/devices",
  component: DevicesRoute,
});

const routeTree = rootRoute.addChildren([indexRoute, devicesRoute]);

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
