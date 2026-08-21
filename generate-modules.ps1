$modules = @(
    @{name="auth"; hasController=$true},
    @{name="users"; hasController=$true},
    @{name="businesses"; hasController=$true},
    @{name="orders"; hasController=$true},
    @{name="tracking"; hasController=$true},
    @{name="notifications"; hasController=$true},
    @{name="upload"; hasController=$true},
    @{name="ratings"; hasController=$true}
)

$baseDir = "c:\tracking\trackdeli-api\src\modules"
New-Item -ItemType Directory -Force -Path $baseDir

foreach ($mod in $modules) {
    $name = $mod.name
    $dir = "$baseDir\$name"
    New-Item -ItemType Directory -Force -Path "$dir\dto"
    
    # Module
    $modName = (Get-Culture).TextInfo.ToTitleCase($name) + "Module"
    $controllerName = (Get-Culture).TextInfo.ToTitleCase($name) + "Controller"
    $serviceName = (Get-Culture).TextInfo.ToTitleCase($name) + "Service"
    
    $imports = "import { Module } from '@nestjs/common';`nimport { $serviceName } from './$name.service';"
    $controllers = ""
    if ($mod.hasController) {
        $imports += "`nimport { $controllerName } from './$name.controller';"
        $controllers = "`n  controllers: [$controllerName],"
    }
    
    $modContent = "$imports`n`n@Module({$controllers`n  providers: [$serviceName],`n})`nexport class $modName {}`n"
    Set-Content -Path "$dir\$name.module.ts" -Value $modContent

    # Service
    $serviceContent = "import { Injectable } from '@nestjs/common';`n`n@Injectable()`nexport class $serviceName {}`n"
    Set-Content -Path "$dir\$name.service.ts" -Value $serviceContent

    # Controller
    if ($mod.hasController) {
        $ctrlContent = "import { Controller, Get } from '@nestjs/common';`nimport { $serviceName } from './$name.service';`n`n@Controller('$name')`nexport class $controllerName {`n  constructor(private readonly service: $serviceName) {}`n`n  @Get('health')`n  healthCheck() {`n    return { status: 'ok', module: '$name' };`n  }`n}`n"
        Set-Content -Path "$dir\$name.controller.ts" -Value $ctrlContent
    }
}
