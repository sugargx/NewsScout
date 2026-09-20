import { FluentProvider } from "@fluentui/react-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { scoutNewsTheme } from "./theme";

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><FluentProvider theme={scoutNewsTheme}><QueryClientProvider client={client}><BrowserRouter><App /></BrowserRouter></QueryClientProvider></FluentProvider></React.StrictMode>);
