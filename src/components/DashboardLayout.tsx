import { Outlet, useNavigation } from "react-router-dom";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { OnboardingBanner } from "@/components/OnboardingBanner";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import logoIcon from "@/assets/logo_icon.png";

function DashboardHeader() {
  const { toggleSidebar, openMobile } = useSidebar();
  const isMobile = useIsMobile();

  return (
    <header className="h-14 flex items-center justify-between border-b border-border px-4 bg-background/80 backdrop-blur-sm sticky top-0 z-30">
      {isMobile ? (
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 h-8 px-2"
          onClick={toggleSidebar}
        >
          {openMobile ? (
            <X className="h-5 w-5" />
          ) : (
            <>
              <Menu className="h-5 w-5" />
              <span className="text-sm font-medium">Menu</span>
            </>
          )}
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={toggleSidebar}
        >
          <Menu className="h-5 w-5" />
        </Button>
      )}
      <div id="dashboard-header-actions" />
    </header>
  );
}

function DashboardContent() {
  const navigation = useNavigation();
  const isNavigating = navigation.state === "loading";

  return (
    <>
      <OnboardingBanner />
      {isNavigating ? (
        <div className="flex-1 flex items-center justify-center">
          <img
            src={logoIcon}
            alt="Carregando..."
            className="w-12 h-12 animate-spin"
            style={{ animationDuration: "1.2s" }}
          />
        </div>
      ) : (
        <main className="flex-1 p-4 md:p-6 overflow-auto">
          <Outlet />
        </main>
      )}
    </>
  );
}

export default function DashboardLayout() {
  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <DashboardHeader />
          <DashboardContent />
        </div>
      </div>
    </SidebarProvider>
  );
}
